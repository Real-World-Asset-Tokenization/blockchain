// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IAssetToken.sol";

/**
 * @title TokenMarketplace
 * @dev Non-custodial, atomic peer-to-peer trading marketplace for fractional ERC-1155 real estate tokens.
 * The seller retains asset tokens in their wallet until an atomic purchase settles.
 * Payments are made via an authorized ERC-20 payment token (e.g. MockPaymentToken / stablecoin).
 */
contract TokenMarketplace is Ownable, ReentrancyGuard {
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

    IAssetToken public immutable assetToken;
    address public treasury;
    uint256 public feeBps; // Platform fee in basis points (100 = 1%)
    uint256 public constant MAX_FEE_BPS = 1000; // 10% maximum fee cap

    uint256 public nextListingId = 1;

    // listingId => Listing
    mapping(uint256 => Listing) public listings;

    // assetId => array of listing IDs
    mapping(uint256 => uint256[]) private _assetListings;
    // seller => array of listing IDs
    mapping(address => uint256[]) private _sellerListings;

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
    event PlatformFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event TreasuryUpdated(address oldTreasury, address newTreasury);

    constructor(
        address _assetToken,
        address _treasury,
        uint256 _feeBps
    ) Ownable(msg.sender) {
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
        Listing storage listing = listings[listingId];
        require(listing.listingId != 0, "Listing does not exist");
        require(listing.status == ListingStatus.Active, "Listing not active");
        if (listing.expiresAt > 0) {
            require(block.timestamp <= listing.expiresAt, "Listing expired");
        }

        address seller = listing.seller;
        require(msg.sender != seller, "Seller cannot purchase own listing");

        uint256 amount = listing.amount;
        uint256 assetId = listing.assetId;
        address paymentTokenAddress = listing.paymentToken;

        // Verify seller still holds sufficient tokens and approval
        require(assetToken.balanceOf(seller, assetId) >= amount, "Seller has insufficient asset tokens");
        require(assetToken.isApprovedForAll(seller, address(this)), "Seller revoked marketplace approval");

        uint256 totalPrice = amount * listing.pricePerToken;
        uint256 platformFee = (totalPrice * feeBps) / 10000;
        uint256 sellerProceeds = totalPrice - platformFee;

        // Effects: mark listing completed before transfers
        listing.status = ListingStatus.Completed;

        IERC20 paymentToken = IERC20(paymentTokenAddress);

        // Verify buyer balance and allowance
        require(paymentToken.balanceOf(msg.sender) >= totalPrice, "Buyer insufficient payment balance");
        require(
            paymentToken.allowance(msg.sender, address(this)) >= totalPrice,
            "Buyer insufficient payment allowance"
        );

        // Interactions: transfer payment to seller and treasury
        paymentToken.safeTransferFrom(msg.sender, seller, sellerProceeds);
        if (platformFee > 0) {
            paymentToken.safeTransferFrom(msg.sender, treasury, platformFee);
        }

        // Transfer asset tokens from seller to buyer
        assetToken.safeTransferFrom(seller, msg.sender, assetId, amount, "");

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
