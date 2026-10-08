// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import "./interfaces/IAssetToken.sol";

/**
 * @title AssetMarketplace
 * @dev Fixed-price marketplace for fractional ERC-1155 real estate tokens.
 * Supports secure escrow, atomic settlement, buy, and cancellation.
 */
contract AssetMarketplace is Ownable, ReentrancyGuard, ERC1155Holder {
    IAssetToken public assetToken;
    uint256 public nextListingId = 1;

    struct Listing {
        uint256 listingId;
        address seller;
        uint256 assetId;
        uint256 amount;
        uint256 pricePerShareWei;
        bool isActive;
    }

    // listingId => Listing
    mapping(uint256 => Listing) public listings;

    event ItemListed(
        uint256 indexed listingId,
        address indexed seller,
        uint256 indexed assetId,
        uint256 amount,
        uint256 pricePerShareWei
    );

    event ItemSold(
        uint256 indexed listingId,
        address indexed buyer,
        address indexed seller,
        uint256 assetId,
        uint256 amount,
        uint256 totalPriceWei
    );

    event ListingCancelled(uint256 indexed listingId, address indexed seller);

    constructor(address _assetToken) Ownable(msg.sender) {
        require(_assetToken != address(0), "Invalid asset token address");
        assetToken = IAssetToken(_assetToken);
    }

    function setAssetToken(address _assetToken) external onlyOwner {
        require(_assetToken != address(0), "Invalid asset token address");
        assetToken = IAssetToken(_assetToken);
    }

    /**
     * @dev Creates a fixed-price listing for ERC-1155 shares.
     * Tokens are deposited into marketplace escrow.
     */
    function listItem(
        uint256 assetId,
        uint256 amount,
        uint256 pricePerShareWei
    ) external nonReentrant returns (uint256) {
        require(amount > 0, "Amount must be > 0");
        require(pricePerShareWei > 0, "Price per share must be > 0");
        require(assetToken.isTokenized(assetId), "Asset not tokenized");
        require(assetToken.balanceOf(msg.sender, assetId) >= amount, "Insufficient balance");

        // Escrow the tokens into marketplace
        assetToken.safeTransferFrom(msg.sender, address(this), assetId, amount, "");

        uint256 listingId = nextListingId++;
        listings[listingId] = Listing({
            listingId: listingId,
            seller: msg.sender,
            assetId: assetId,
            amount: amount,
            pricePerShareWei: pricePerShareWei,
            isActive: true
        });

        emit ItemListed(listingId, msg.sender, assetId, amount, pricePerShareWei);
        return listingId;
    }

    /**
     * @dev Purchases shares from an active listing.
     * Settles atomically: transfers tokens to buyer, transfers ETH to seller.
     */
    function buyItem(uint256 listingId, uint256 amountToBuy) external payable nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.isActive, "Listing not active");
        require(amountToBuy > 0 && amountToBuy <= listing.amount, "Invalid amount");

        uint256 totalPrice = amountToBuy * listing.pricePerShareWei;
        require(msg.value == totalPrice, "Incorrect payment amount");

        listing.amount -= amountToBuy;
        if (listing.amount == 0) {
            listing.isActive = false;
        }

        address seller = listing.seller;
        uint256 assetId = listing.assetId;

        // Transfer tokens to buyer
        assetToken.safeTransferFrom(address(this), msg.sender, assetId, amountToBuy, "");

        // Transfer ETH payment to seller
        (bool sent, ) = payable(seller).call{value: msg.value}("");
        require(sent, "Failed to send ETH to seller");

        emit ItemSold(listingId, msg.sender, seller, assetId, amountToBuy, totalPrice);
    }

    /**
     * @dev Cancels an active listing and refunds escrowed tokens to seller.
     */
    function cancelListing(uint256 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.isActive, "Listing not active");
        require(msg.sender == listing.seller || msg.sender == owner(), "Unauthorized");

        listing.isActive = false;
        uint256 remainingAmount = listing.amount;
        listing.amount = 0;

        assetToken.safeTransferFrom(address(this), listing.seller, listing.assetId, remainingAmount, "");

        emit ListingCancelled(listingId, listing.seller);
    }

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return listings[listingId];
    }
}
