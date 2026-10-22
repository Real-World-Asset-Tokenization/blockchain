// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./interfaces/IAssetToken.sol";
import "./interfaces/IAssetRegistry.sol";

/// @dev The approved price per token, published by AssetValuationRegistry (in LKR cents).
interface IReferencePrice {
    function getReferencePriceCents(uint256 assetId) external view returns (uint256);
}

/**
 * @title TokenMarketplace
 * @dev Non-custodial, atomic peer-to-peer trading marketplace for fractional ERC-1155 real estate tokens.
 * The seller retains asset tokens in their wallet until an atomic purchase settles.
 * Payments are made via an authorized ERC-20 payment token (e.g. MockPaymentToken / stablecoin).
 */
contract TokenMarketplace is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    enum ListingStatus { Active, Completed, Cancelled }

    struct Listing {
        uint256 listingId;
        address seller;
        uint256 assetId;
        uint256 amount;
        uint256 pricePerToken; // In payment token base units
        address paymentToken;  // ERC-20 payment contract address
        uint256 createdAt;
        uint256 expiresAt;     // 0 = no expiration
        ListingStatus status;
    }

    // Off-chain order the seller signs (EIP-712). Nothing is stored on-chain until a buyer fills it.
    struct Order {
        address seller;
        uint256 assetId;
        uint256 amount;
        uint256 pricePerToken;
        address paymentToken;
        uint256 expiry; // unix seconds, 0 = no expiration
        uint256 salt;   // lets a seller sign several otherwise identical orders
    }

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address seller,uint256 assetId,uint256 amount,uint256 pricePerToken,address paymentToken,uint256 expiry,uint256 salt)"
    );

    IAssetToken public immutable assetToken;
    address public treasury;
    uint256 public feeBps; // Platform fee in basis points (100 = 1%)
    uint256 public constant MAX_FEE_BPS = 1000; // 10% maximum fee cap
    // Share of every resale paid to the original asset owner (the issuer). Primary sales by the issuer pay none.
    uint256 public royaltyBps;
    uint256 public constant MAX_ROYALTY_BPS = 1000; // 10% maximum royalty cap

    uint256 public nextListingId = 1;

    // listingId => Listing
    mapping(uint256 => Listing) public listings;

    // assetId => array of listing IDs
    mapping(uint256 => uint256[]) private _assetListings;
    // seller => array of listing IDs
    mapping(address => uint256[]) private _sellerListings;

    // orderHash => tokens already bought from a signed order
    mapping(bytes32 => uint256) public orderFilled;
    mapping(bytes32 => bool) public orderCancelled;

    // Source of the approved price, used by offers that follow the property's valuation.
    IReferencePrice public valuation;
    // LKR per 1 USD with two decimals (31000 = 310.00). The approved price is published in LKR, payments are in mUSD (6 decimals).
    uint256 public lkrPerUsdX100 = 31000;
    int256 public constant MIN_PREMIUM_BPS = -5000; // at most 50% below the approved price
    int256 public constant MAX_PREMIUM_BPS = 10000; // at most 100% above it

    // An offer that does not fix a price. The price is worked out when someone buys:
    // approved price per token x (1 + premium), never below the seller's floor.
    struct FollowOrder {
        address seller;
        uint256 assetId;
        uint256 amount;
        int256 premiumBps; // 0 = approved price, -500 = 5% below, 500 = 5% above
        uint256 floorPrice; // lowest price per token the seller accepts, in payment token units
        address paymentToken;
        uint256 expiry; // unix seconds, 0 = no expiration
        uint256 salt;
    }

    bytes32 public constant FOLLOW_ORDER_TYPEHASH = keccak256(
        "FollowOrder(address seller,uint256 assetId,uint256 amount,int256 premiumBps,uint256 floorPrice,address paymentToken,uint256 expiry,uint256 salt)"
    );

    event ValuationRegistryUpdated(address registry);
    event LkrRateUpdated(uint256 oldRateX100, uint256 newRateX100);

    event ListingCreated(
        uint256 indexed listingId,
        address indexed seller,
        uint256 indexed assetId,
        uint256 amount,
        uint256 pricePerToken,
        address paymentToken,
        uint256 expiresAt
    );

    event ListingPurchased(
        uint256 indexed listingId,
        address indexed buyer,
        address indexed seller,
        uint256 assetId,
        uint256 amount,
        uint256 totalPrice,
        uint256 platformFee,
        address paymentToken
    );

    event ListingCancelled(uint256 indexed listingId, address indexed seller);
    event SignedOrderFilled(
        bytes32 indexed orderHash,
        address indexed seller,
        address indexed buyer,
        uint256 assetId,
        uint256 amount,
        uint256 totalPrice,
        uint256 platformFee,
        address paymentToken
    );
    event SignedOrderCancelled(bytes32 indexed orderHash, address indexed seller);
    event RoyaltyPaid(uint256 indexed assetId, address indexed issuer, address indexed seller, uint256 amount);
    event RoyaltyUpdated(uint256 oldRoyaltyBps, uint256 newRoyaltyBps);
    event PlatformFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event TreasuryUpdated(address oldTreasury, address newTreasury);

    constructor(
        address _assetToken,
        address _treasury,
        uint256 _feeBps
    ) Ownable(msg.sender) EIP712("TokenMarketplace", "1") {
        require(_assetToken != address(0), "Invalid asset token address");
        require(_treasury != address(0), "Invalid treasury address");
        require(_feeBps <= MAX_FEE_BPS, "Fee exceeds maximum basis points");

        assetToken = IAssetToken(_assetToken);
        treasury = _treasury;
        feeBps = _feeBps;
    }

    /**
     * @dev Updates the platform trading fee in basis points.
     */
    function setFeeBps(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= MAX_FEE_BPS, "Fee exceeds maximum basis points");
        uint256 oldFee = feeBps;
        feeBps = _feeBps;
        emit PlatformFeeUpdated(oldFee, _feeBps);
    }

    /**
     * @dev Updates the resale royalty paid to the original asset owner, in basis points.
     */
    function setRoyaltyBps(uint256 _royaltyBps) external onlyOwner {
        require(_royaltyBps <= MAX_ROYALTY_BPS, "Royalty exceeds maximum basis points");
        uint256 oldRoyalty = royaltyBps;
        royaltyBps = _royaltyBps;
        emit RoyaltyUpdated(oldRoyalty, _royaltyBps);
    }

    /**
     * @dev Updates the treasury wallet address receiving platform trading fees.
     */
    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "Invalid treasury address");
        address oldTreasury = treasury;
        treasury = _treasury;
        emit TreasuryUpdated(oldTreasury, _treasury);
    }

    /**
     * @dev Create a non-custodial listing for fractional asset tokens.
     * Tokens remain in seller's wallet until purchased.
     * Seller must have called `assetToken.setApprovalForAll(marketplace, true)`.
     */
    function createListing(
        uint256 assetId,
        uint256 amount,
        uint256 pricePerToken,
        address paymentToken,
        uint256 durationSeconds
    ) external nonReentrant returns (uint256) {
        require(amount > 0, "Amount must be > 0");
        require(pricePerToken > 0, "Price per token must be > 0");
        require(paymentToken != address(0), "Invalid payment token");
        require(assetToken.isTokenized(assetId), "Asset not tokenized");
        require(assetToken.balanceOf(msg.sender, assetId) >= amount, "Insufficient token balance");
        require(
            assetToken.isApprovedForAll(msg.sender, address(this)),
            "Marketplace not approved for asset tokens"
        );

        uint256 expiresAt = durationSeconds > 0 ? block.timestamp + durationSeconds : 0;
        uint256 listingId = nextListingId++;

        listings[listingId] = Listing({
            listingId: listingId,
            seller: msg.sender,
            assetId: assetId,
            amount: amount,
            pricePerToken: pricePerToken,
            paymentToken: paymentToken,
            createdAt: block.timestamp,
            expiresAt: expiresAt,
            status: ListingStatus.Active
        });

        _assetListings[assetId].push(listingId);
        _sellerListings[msg.sender].push(listingId);

        emit ListingCreated(
            listingId,
            msg.sender,
            assetId,
            amount,
            pricePerToken,
            paymentToken,
            expiresAt
        );

        return listingId;
    }

    /**
     * @dev Purchases listed tokens atomically.
     * Transfers ERC-20 payment tokens from buyer to seller and treasury.
     * Transfers ERC-1155 asset tokens directly from seller to buyer.
     */
    function buyListing(uint256 listingId) external nonReentrant {
        _buyListing(listingId, listings[listingId].amount);
    }

    function buyListingAmount(uint256 listingId, uint256 amount) external nonReentrant {
        _buyListing(listingId, amount);
    }

    function _buyListing(uint256 listingId, uint256 amount) internal {
        Listing storage listing = listings[listingId];
        require(listing.listingId != 0, "Listing does not exist");
        require(listing.status == ListingStatus.Active, "Listing not active");
        if (listing.expiresAt > 0) {
            require(block.timestamp <= listing.expiresAt, "Listing expired");
        }

        address seller = listing.seller;
        require(msg.sender != seller, "Seller cannot purchase own listing");

        require(amount > 0 && amount <= listing.amount, "Invalid purchase amount");
        uint256 assetId = listing.assetId;
        address paymentTokenAddress = listing.paymentToken;

        uint256 pricePerToken = listing.pricePerToken;

        // Reduce the remaining offer before interactions; keep partial fills active.
        listing.amount -= amount;
        if (listing.amount == 0) listing.status = ListingStatus.Completed;

        (uint256 totalPrice, uint256 platformFee) = _settle(
            seller, msg.sender, assetId, amount, pricePerToken, paymentTokenAddress
        );

        emit ListingPurchased(
            listingId,
            msg.sender,
            seller,
            assetId,
            amount,
            totalPrice,
            platformFee,
            paymentTokenAddress
        );
    }

    /**
     * @dev Pays the seller, the treasury and (on resales) the original owner, then moves the tokens.
     * Shared by on-chain listings and signed orders so both settle identically.
     */
    function _settle(
        address seller,
        address buyer,
        uint256 assetId,
        uint256 amount,
        uint256 pricePerToken,
        address paymentTokenAddress
    ) internal returns (uint256 totalPrice, uint256 platformFee) {
        require(assetToken.balanceOf(seller, assetId) >= amount, "Seller has insufficient asset tokens");
        require(assetToken.isApprovedForAll(seller, address(this)), "Seller revoked marketplace approval");

        totalPrice = amount * pricePerToken;
        platformFee = (totalPrice * feeBps) / 10000;

        address issuer;
        uint256 royalty;
        if (royaltyBps > 0) {
            issuer = IAssetRegistry(assetToken.getAssetRegistry()).getAsset(assetId).issuer;
            if (seller != issuer) royalty = (totalPrice * royaltyBps) / 10000;
        }

        IERC20 paymentToken = IERC20(paymentTokenAddress);
        require(paymentToken.balanceOf(buyer) >= totalPrice, "Buyer insufficient payment balance");
        require(
            paymentToken.allowance(buyer, address(this)) >= totalPrice,
            "Buyer insufficient payment allowance"
        );

        paymentToken.safeTransferFrom(buyer, seller, totalPrice - platformFee - royalty);
        if (platformFee > 0) {
            paymentToken.safeTransferFrom(buyer, treasury, platformFee);
        }
        if (royalty > 0) {
            paymentToken.safeTransferFrom(buyer, issuer, royalty);
            emit RoyaltyPaid(assetId, issuer, seller, royalty);
        }

        assetToken.safeTransferFrom(seller, buyer, assetId, amount, "");
    }

    /**
     * @dev EIP-712 hash of an order, the value the seller signs.
     */
    function hashOrder(Order calldata order) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ORDER_TYPEHASH,
                    order.seller,
                    order.assetId,
                    order.amount,
                    order.pricePerToken,
                    order.paymentToken,
                    order.expiry,
                    order.salt
                )
            )
        );
    }

    /**
     * @dev Buys tokens from an order the seller signed off-chain. The seller pays no gas to list;
     * the buyer's transaction both verifies the signature and settles. Partial fills are allowed.
     */
    function fillSignedOrder(
        Order calldata order,
        bytes calldata signature,
        uint256 amount
    ) external nonReentrant {
        _fillSignedOrder(order, signature, amount);
    }

    /**
     * @dev Same as fillSignedOrder, but the buyer also signs an ERC-2612 permit off-chain, so the
     * payment allowance is granted inside this transaction. This saves the separate approve transaction.
     * A permit that was already used or front-run is ignored when the allowance is already enough.
     */
    function fillSignedOrderWithPermit(
        Order calldata order,
        bytes calldata signature,
        uint256 amount,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        uint256 cost = amount * order.pricePerToken;
        try IERC20Permit(order.paymentToken).permit(msg.sender, address(this), cost, permitDeadline, v, r, s) {} catch {}
        _fillSignedOrder(order, signature, amount);
    }

    function _fillSignedOrder(
        Order calldata order,
        bytes calldata signature,
        uint256 amount
    ) internal {
        bytes32 orderHash = hashOrder(order);
        require(ECDSA.recover(orderHash, signature) == order.seller, "Invalid order signature");
        require(!orderCancelled[orderHash], "Order cancelled");
        if (order.expiry > 0) {
            require(block.timestamp <= order.expiry, "Order expired");
        }
        require(msg.sender != order.seller, "Seller cannot purchase own order");
        require(order.pricePerToken > 0 && order.paymentToken != address(0), "Invalid order");
        require(assetToken.isTokenized(order.assetId), "Asset not tokenized");
        require(
            amount > 0 && orderFilled[orderHash] + amount <= order.amount,
            "Invalid purchase amount"
        );

        orderFilled[orderHash] += amount;

        (uint256 totalPrice, uint256 platformFee) = _settle(
            order.seller, msg.sender, order.assetId, amount, order.pricePerToken, order.paymentToken
        );

        emit SignedOrderFilled(
            orderHash, order.seller, msg.sender, order.assetId, amount, totalPrice, platformFee, order.paymentToken
        );
    }

    /**
     * @dev Seller (or the contract owner) invalidates a signed order so it can no longer be filled.
     */
    function cancelSignedOrder(Order calldata order) external {
        require(msg.sender == order.seller || msg.sender == owner(), "Unauthorized cancellation");
        bytes32 orderHash = hashOrder(order);
        orderCancelled[orderHash] = true;
        emit SignedOrderCancelled(orderHash, order.seller);
    }

    // ------------------------------------------------------------------
    // Offers that follow the property's approved price
    // ------------------------------------------------------------------

    function setValuationRegistry(address registry) external onlyOwner {
        require(registry != address(0), "Invalid registry address");
        valuation = IReferencePrice(registry);
        emit ValuationRegistryUpdated(registry);
    }

    function setLkrPerUsd(uint256 rateX100) external onlyOwner {
        require(rateX100 > 0, "Rate must be above zero");
        emit LkrRateUpdated(lkrPerUsdX100, rateX100);
        lkrPerUsdX100 = rateX100;
    }

    /// @dev Approved price per token in payment token units (mUSD, 6 decimals), read live from the valuation registry.
    function referencePrice(uint256 assetId) public view returns (uint256) {
        require(address(valuation) != address(0), "Valuation registry not set");
        return (valuation.getReferencePriceCents(assetId) * 1e6) / lkrPerUsdX100;
    }

    /// @dev The price per token a follow order costs right now.
    function followPrice(FollowOrder calldata order) public view returns (uint256 price) {
        require(order.premiumBps >= MIN_PREMIUM_BPS && order.premiumBps <= MAX_PREMIUM_BPS, "Premium out of range");
        price = (referencePrice(order.assetId) * uint256(10000 + order.premiumBps)) / 10000;
        require(price > 0 && price >= order.floorPrice, "Price below seller minimum");
    }

    function hashFollowOrder(FollowOrder calldata order) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    FOLLOW_ORDER_TYPEHASH,
                    order.seller,
                    order.assetId,
                    order.amount,
                    order.premiumBps,
                    order.floorPrice,
                    order.paymentToken,
                    order.expiry,
                    order.salt
                )
            )
        );
    }

    /**
     * @dev Buys from an offer that follows the approved price. The buyer states the highest price per
     * token they accept, so a revaluation that lands just before the purchase cannot cost them more.
     */
    function fillFollowOrder(
        FollowOrder calldata order,
        bytes calldata signature,
        uint256 amount,
        uint256 maxPricePerToken
    ) external nonReentrant {
        _fillFollowOrder(order, signature, amount, maxPricePerToken);
    }

    /// @dev Same, with the payment allowance granted by an ERC-2612 permit (up to amount x maxPricePerToken).
    function fillFollowOrderWithPermit(
        FollowOrder calldata order,
        bytes calldata signature,
        uint256 amount,
        uint256 maxPricePerToken,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        try IERC20Permit(order.paymentToken).permit(msg.sender, address(this), amount * maxPricePerToken, permitDeadline, v, r, s) {} catch {}
        _fillFollowOrder(order, signature, amount, maxPricePerToken);
    }

    function _fillFollowOrder(
        FollowOrder calldata order,
        bytes calldata signature,
        uint256 amount,
        uint256 maxPricePerToken
    ) internal {
        bytes32 orderHash = hashFollowOrder(order);
        require(ECDSA.recover(orderHash, signature) == order.seller, "Invalid order signature");
        require(!orderCancelled[orderHash], "Order cancelled");
        if (order.expiry > 0) {
            require(block.timestamp <= order.expiry, "Order expired");
        }
        require(msg.sender != order.seller, "Seller cannot purchase own order");
        require(order.paymentToken != address(0), "Invalid order");
        require(assetToken.isTokenized(order.assetId), "Asset not tokenized");
        require(amount > 0 && orderFilled[orderHash] + amount <= order.amount, "Invalid purchase amount");
        _executeFollow(order, orderHash, amount, maxPricePerToken);
    }

    function _executeFollow(
        FollowOrder calldata order,
        bytes32 orderHash,
        uint256 amount,
        uint256 maxPricePerToken
    ) private {
        uint256 price = followPrice(order);
        require(price <= maxPricePerToken, "Price above buyer limit");

        orderFilled[orderHash] += amount;

        (uint256 totalPrice, uint256 platformFee) = _settle(
            order.seller, msg.sender, order.assetId, amount, price, order.paymentToken
        );

        emit SignedOrderFilled(
            orderHash, order.seller, msg.sender, order.assetId, amount, totalPrice, platformFee, order.paymentToken
        );
    }

    function cancelFollowOrder(FollowOrder calldata order) external {
        require(msg.sender == order.seller || msg.sender == owner(), "Unauthorized cancellation");
        bytes32 orderHash = hashFollowOrder(order);
        orderCancelled[orderHash] = true;
        emit SignedOrderCancelled(orderHash, order.seller);
    }

    /**
     * @dev Cancels an active listing.
     * Can only be called by the seller or the contract owner.
     */
    function cancelListing(uint256 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.listingId != 0, "Listing does not exist");
        require(listing.status == ListingStatus.Active, "Listing not active");
        require(msg.sender == listing.seller || msg.sender == owner(), "Unauthorized cancellation");

        listing.status = ListingStatus.Cancelled;

        emit ListingCancelled(listingId, listing.seller);
    }

    /**
     * @dev Retrieves a listing by ID.
     */
    function getListing(uint256 listingId) external view returns (Listing memory) {
        require(listings[listingId].listingId != 0, "Listing does not exist");
        return listings[listingId];
    }

    /**
     * @dev Retrieves all listings for a specific asset.
     */
    function getListingsByAsset(uint256 assetId) external view returns (uint256[] memory) {
        return _assetListings[assetId];
    }

    /**
     * @dev Retrieves all listings created by a seller.
     */
    function getListingsBySeller(address seller) external view returns (uint256[] memory) {
        return _sellerListings[seller];
    }

    /**
     * @dev Retrieves total number of listings created.
     */
    function totalListings() external view returns (uint256) {
        return nextListingId - 1;
    }
}
