const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("TokenMarketplace Contract - Non-Custodial Trading Suite", function () {
  let registry, assetToken, paymentToken, marketplace;
  let admin, treasury, seller, buyer, unauthorized;

  const mockAsset = {
    name: "Colombo Oceanfront Residence",
    symbol: "COR-01",
    metadataURI: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/colombo.json",
    documentHash: "0x9f83c6138438914b1bf0597bc5f8f5339f40feef2c95e5d326f9661d9a5b6d92",
    valuationLKR: 10000000n,
    totalShares: 1000n
  };

  const FEE_BPS = 100n; // 1%
  const PRICE_PER_TOKEN = ethers.parseUnits("100", 6); // 100 mUSD per token (6 decimals)

  beforeEach(async function () {
    [admin, treasury, seller, buyer, unauthorized] = await ethers.getSigners();

    // 1. Deploy AssetRegistry
    const AssetRegistry = await ethers.getContractFactory("AssetRegistry");
    registry = await AssetRegistry.deploy();
    await registry.waitForDeployment();

    // 2. Deploy AssetToken
    const AssetToken = await ethers.getContractFactory("AssetToken");
    assetToken = await AssetToken.deploy(await registry.getAddress());
    await assetToken.waitForDeployment();
    await registry.setAssetTokenContract(await assetToken.getAddress());

    // 3. Deploy MockPaymentToken (mUSD, 6 decimals)
    const MockPaymentToken = await ethers.getContractFactory("MockPaymentToken");
    paymentToken = await MockPaymentToken.deploy("Mock USD", "mUSD", 6);
    await paymentToken.waitForDeployment();

    // 4. Deploy TokenMarketplace
    const TokenMarketplace = await ethers.getContractFactory("TokenMarketplace");
    marketplace = await TokenMarketplace.deploy(
      await assetToken.getAddress(),
      treasury.address,
      FEE_BPS
    );
    await marketplace.waitForDeployment();

    // 5. Onboard & tokenize Asset 1
    await registry.connect(seller).registerAsset(
      mockAsset.name,
      mockAsset.symbol,
      mockAsset.metadataURI,
      mockAsset.documentHash,
      mockAsset.valuationLKR,
      mockAsset.totalShares
    );
    await registry.approveAsset(1);
    await assetToken.tokenizeAsset(1, seller.address);

    // Verify initial setup
    expect(await assetToken.balanceOf(seller.address, 1)).to.equal(1000n);

    // Fund buyer with 50,000 mUSD
    await paymentToken.mint(buyer.address, ethers.parseUnits("50000", 6));
  });

  describe("Listing Creation", function () {
    it("Seller creates a valid non-custodial listing after approving marketplace", async function () {
      await assetToken.connect(seller).setApprovalForAll(await marketplace.getAddress(), true);

      const tx = await marketplace.connect(seller).createListing(
        1,
        100n, // 100 tokens
        PRICE_PER_TOKEN,
        await paymentToken.getAddress(),
        3600 // 1 hour expiration
      );

      await expect(tx)
        .to.emit(marketplace, "ListingCreated")
        .withArgs(1n, seller.address, 1n, 100n, PRICE_PER_TOKEN, await paymentToken.getAddress(), (await time.latest()) + 3600);

      const listing = await marketplace.getListing(1);
      expect(listing.seller).to.equal(seller.address);
      expect(listing.assetId).to.equal(1n);
      expect(listing.amount).to.equal(100n);
      expect(listing.pricePerToken).to.equal(PRICE_PER_TOKEN);
      expect(listing.status).to.equal(0); // Active

      // Verify non-custodial: tokens remain in seller's wallet until sale
      expect(await assetToken.balanceOf(seller.address, 1)).to.equal(1000n);
    });

    it("Reverts if seller has not approved marketplace", async function () {
      await expect(
        marketplace.connect(seller).createListing(
          1,
          100n,
          PRICE_PER_TOKEN,
          await paymentToken.getAddress(),
          0
        )
      ).to.be.revertedWith("Marketplace not approved for asset tokens");
    });

    it("Reverts if seller has insufficient asset balance", async function () {
      await assetToken.connect(seller).setApprovalForAll(await marketplace.getAddress(), true);

      await expect(
        marketplace.connect(seller).createListing(
          1,
          1001n, // exceeds 1000 shares
          PRICE_PER_TOKEN,
          await paymentToken.getAddress(),
          0
        )
      ).to.be.revertedWith("Insufficient token balance");
    });
  });

  describe("Token Purchase Settlement", function () {
    beforeEach(async function () {
      await assetToken.connect(seller).setApprovalForAll(await marketplace.getAddress(), true);
      await marketplace.connect(seller).createListing(
        1,
        100n,
        PRICE_PER_TOKEN,
        await paymentToken.getAddress(),
        3600
      );
    });

    it("Supports partial purchases and preserves the remaining offer", async function () {
      await paymentToken.connect(buyer).approve(await marketplace.getAddress(), 100n * PRICE_PER_TOKEN);
      await expect(marketplace.connect(buyer).buyListingAmount(1, 25))
        .to.emit(marketplace, "ListingPurchased")
        .withArgs(1, buyer.address, seller.address, 1, 25, 25n * PRICE_PER_TOKEN, 25n * PRICE_PER_TOKEN / 100n, await paymentToken.getAddress());
      const remaining = await marketplace.getListing(1);
      expect(remaining.amount).to.equal(75);
      expect(remaining.status).to.equal(0);
      expect(await assetToken.balanceOf(buyer.address, 1)).to.equal(25);
      expect(await assetToken.balanceOf(seller.address, 1)).to.equal(975);
      await marketplace.connect(buyer).buyListing(1);
      expect((await marketplace.getListing(1)).amount).to.equal(0);
      expect((await marketplace.getListing(1)).status).to.equal(1);
      expect(await assetToken.balanceOf(buyer.address, 1)).to.equal(100);
    });

    it("Rejects invalid partial quantities and leaves the offer unchanged", async function () {
      await expect(marketplace.connect(buyer).buyListingAmount(1, 0)).to.be.revertedWith("Invalid purchase amount");
      await expect(marketplace.connect(buyer).buyListingAmount(1, 101)).to.be.revertedWith("Invalid purchase amount");
      expect((await marketplace.getListing(1)).amount).to.equal(100);
    });

    it("Buyer purchases listing: atomic settlement, fees, and ownership transfer", async function () {
      const totalPrice = 100n * PRICE_PER_TOKEN; // 10,000 mUSD
      const expectedPlatformFee = (totalPrice * FEE_BPS) / 10000n; // 100 mUSD (1%)
      const expectedSellerProceeds = totalPrice - expectedPlatformFee; // 9,900 mUSD

      // Buyer approves marketplace to spend payment token
      await paymentToken.connect(buyer).approve(await marketplace.getAddress(), totalPrice);

      const initialSellerPaymentBal = await paymentToken.balanceOf(seller.address);
      const initialTreasuryPaymentBal = await paymentToken.balanceOf(treasury.address);

      const tx = await marketplace.connect(buyer).buyListing(1);

      await expect(tx)
        .to.emit(marketplace, "ListingPurchased")
        .withArgs(
          1n,
          buyer.address,
          seller.address,
          1n,
          100n,
          totalPrice,
          expectedPlatformFee,
          await paymentToken.getAddress()
        );

      // Verify token ownership transfer
      expect(await assetToken.balanceOf(seller.address, 1)).to.equal(900n);
      expect(await assetToken.balanceOf(buyer.address, 1)).to.equal(100n);

      // Verify payment settlement
      expect(await paymentToken.balanceOf(seller.address) - initialSellerPaymentBal).to.equal(expectedSellerProceeds);
      expect(await paymentToken.balanceOf(treasury.address) - initialTreasuryPaymentBal).to.equal(expectedPlatformFee);

      // Verify listing status marked Completed
      const listing = await marketplace.getListing(1);
      expect(listing.status).to.equal(1); // Completed
    });

    it("Reverts if buyer has insufficient payment allowance", async function () {
      const totalPrice = 100n * PRICE_PER_TOKEN;
      await paymentToken.connect(buyer).approve(await marketplace.getAddress(), totalPrice - 1n);

      await expect(
        marketplace.connect(buyer).buyListing(1)
      ).to.be.revertedWith("Buyer insufficient payment allowance");
    });

    it("Reverts if buyer tries to purchase their own listing", async function () {
      await expect(
        marketplace.connect(seller).buyListing(1)
      ).to.be.revertedWith("Seller cannot purchase own listing");
    });

    it("Reverts if listing is already completed (replay prevention)", async function () {
      const totalPrice = 100n * PRICE_PER_TOKEN;
      await paymentToken.connect(buyer).approve(await marketplace.getAddress(), totalPrice);
      await marketplace.connect(buyer).buyListing(1);

      await expect(
        marketplace.connect(buyer).buyListing(1)
      ).to.be.revertedWith("Listing not active");
    });

    it("Reverts if seller revoked asset token approval after listing", async function () {
      await assetToken.connect(seller).setApprovalForAll(await marketplace.getAddress(), false);

      const totalPrice = 100n * PRICE_PER_TOKEN;
      await paymentToken.connect(buyer).approve(await marketplace.getAddress(), totalPrice);

      await expect(
        marketplace.connect(buyer).buyListing(1)
      ).to.be.revertedWith("Seller revoked marketplace approval");
    });

    it("Reverts if listing has expired", async function () {
      // Advance time by 3601 seconds
      await time.increase(3601);

      const totalPrice = 100n * PRICE_PER_TOKEN;
      await paymentToken.connect(buyer).approve(await marketplace.getAddress(), totalPrice);

      await expect(
        marketplace.connect(buyer).buyListing(1)
      ).to.be.revertedWith("Listing expired");
    });
  });

  describe("Listing Cancellation", function () {
    beforeEach(async function () {
      await assetToken.connect(seller).setApprovalForAll(await marketplace.getAddress(), true);
      await marketplace.connect(seller).createListing(
        1,
        100n,
        PRICE_PER_TOKEN,
        await paymentToken.getAddress(),
        0
      );
    });

    it("Seller can cancel their active listing", async function () {
      const tx = await marketplace.connect(seller).cancelListing(1);
      await expect(tx)
        .to.emit(marketplace, "ListingCancelled")
        .withArgs(1n, seller.address);

      const listing = await marketplace.getListing(1);
      expect(listing.status).to.equal(2); // Cancelled

      // Buyer cannot buy cancelled listing
      const totalPrice = 100n * PRICE_PER_TOKEN;
      await paymentToken.connect(buyer).approve(await marketplace.getAddress(), totalPrice);
      await expect(marketplace.connect(buyer).buyListing(1)).to.be.revertedWith("Listing not active");
    });

    it("Contract owner/admin can cancel listing for moderation", async function () {
      await expect(marketplace.connect(admin).cancelListing(1))
        .to.emit(marketplace, "ListingCancelled")
        .withArgs(1n, seller.address);
    });

    it("Unauthorized user cannot cancel listing", async function () {
      await expect(
        marketplace.connect(unauthorized).cancelListing(1)
      ).to.be.revertedWith("Unauthorized cancellation");
    });
  });

  describe("Administrative Settings", function () {
    it("Admin can update platform fee bps up to max cap", async function () {
      await expect(marketplace.connect(admin).setFeeBps(250n))
        .to.emit(marketplace, "PlatformFeeUpdated")
        .withArgs(100n, 250n);

      expect(await marketplace.feeBps()).to.equal(250n);
    });

    it("Reverts if fee exceeds MAX_FEE_BPS (10%)", async function () {
      await expect(
        marketplace.connect(admin).setFeeBps(1001n)
      ).to.be.revertedWith("Fee exceeds maximum basis points");
    });

    it("Admin can update treasury address", async function () {
      await expect(marketplace.connect(admin).setTreasury(unauthorized.address))
        .to.emit(marketplace, "TreasuryUpdated")
        .withArgs(treasury.address, unauthorized.address);

      expect(await marketplace.treasury()).to.equal(unauthorized.address);
    });
  });
});
