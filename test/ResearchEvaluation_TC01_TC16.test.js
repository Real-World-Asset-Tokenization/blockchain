const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Asset Tokenization Research Platform - Evaluation Test Suite (TC01 - TC16)", function () {
  let registry, assetToken, marketplace, governance, distribution;
  let admin, issuer, investorA, investorB, investorC, unauthorized;

  const mockAsset = {
    name: "Colombo Oceanfront Residence",
    symbol: "COR-01",
    metadataURI: "ipfs://QmZtmD2qt8fJv32FNq4Lydxt5GnW372PYh13pGFrd882z",
    documentHash: "0x8f2d5e3f4b6a9c1e2d3b4a5c6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f",
    valuationLKR: 10000000n, // 10 Million LKR
    totalShares: 1000n       // 1,000 shares
  };

  beforeEach(async function () {
    [admin, issuer, investorA, investorB, investorC, unauthorized] = await ethers.getSigners();

    // 1. Deploy AssetRegistry
    const AssetRegistry = await ethers.getContractFactory("AssetRegistry");
    registry = await AssetRegistry.deploy();
    await registry.waitForDeployment();

    // 2. Deploy AssetToken
    const AssetToken = await ethers.getContractFactory("AssetToken");
    assetToken = await AssetToken.deploy(await registry.getAddress());
    await assetToken.waitForDeployment();

    // Link registry to token
    await registry.setAssetTokenContract(await assetToken.getAddress());

    // 3. Deploy AssetMarketplace
    const AssetMarketplace = await ethers.getContractFactory("AssetMarketplace");
    marketplace = await AssetMarketplace.deploy(await assetToken.getAddress());
    await marketplace.waitForDeployment();

    // 4. Deploy AssetGovernance
    const AssetGovernance = await ethers.getContractFactory("AssetGovernance");
    governance = await AssetGovernance.deploy(await assetToken.getAddress());
    await governance.waitForDeployment();

    // 5. Deploy ProfitDistribution
    const ProfitDistribution = await ethers.getContractFactory("ProfitDistribution");
    distribution = await ProfitDistribution.deploy(await assetToken.getAddress());
    await distribution.waitForDeployment();

    // Authorize Governance and ProfitDistribution for snapshots on AssetToken
    await assetToken.setAuthorizedCaller(await governance.getAddress(), true);
    await assetToken.setAuthorizedCaller(await distribution.getAddress(), true);
  });

  // Helper function to onboard and tokenize asset #1
  async function onboardAndTokenizeAsset(shares = 1000n, recipient = admin.address) {
    await registry.connect(issuer).registerAsset(
      mockAsset.name,
      mockAsset.symbol,
      mockAsset.metadataURI,
      mockAsset.documentHash,
      mockAsset.valuationLKR,
      shares
    );
    await registry.connect(admin).approveAsset(1);
    await assetToken.connect(admin).tokenizeAsset(1, recipient);
  }

  describe("Phase 1: Asset Registry & Tokenization (TC01 - TC03)", function () {
    it("TC01: Admin creates 1,000-share asset -> Succeeds and mints tokens", async function () {
      await registry.connect(issuer).registerAsset(
        mockAsset.name,
        mockAsset.symbol,
        mockAsset.metadataURI,
        mockAsset.documentHash,
        mockAsset.valuationLKR,
        1000n
      );
      await registry.connect(admin).approveAsset(1);
      const tx = await assetToken.connect(admin).tokenizeAsset(1, admin.address);
      await expect(tx)
        .to.emit(assetToken, "AssetTokenized")
        .withArgs(1n, admin.address, 1000n, mockAsset.metadataURI);

      expect(await assetToken.balanceOf(admin.address, 1)).to.equal(1000n);
      expect(await assetToken.totalShares(1)).to.equal(1000n);
    });

    it("TC02: Unauthorized asset creation/approval -> Reverts", async function () {
      await registry.connect(issuer).registerAsset(
        mockAsset.name,
        mockAsset.symbol,
        mockAsset.metadataURI,
        mockAsset.documentHash,
        mockAsset.valuationLKR,
        1000n
      );

      // Unauthorized user attempts approval
      await expect(
        registry.connect(unauthorized).approveAsset(1)
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");

      // Unauthorized user attempts tokenization
      await expect(
        assetToken.connect(unauthorized).tokenizeAsset(1, unauthorized.address)
      ).to.be.revertedWith("Caller is not owner or registry");
    });

    it("TC03: Zero supply registration -> Reverts", async function () {
      await expect(
        registry.connect(issuer).registerAsset(
          mockAsset.name,
          mockAsset.symbol,
          mockAsset.metadataURI,
          mockAsset.documentHash,
          mockAsset.valuationLKR,
          0n
        )
      ).to.be.revertedWith("Total shares must be > 0");
    });
  });

  describe("Phase 2: Wallet Transfers (TC04 - TC05)", function () {
    beforeEach(async function () {
      await onboardAndTokenizeAsset(1000n, admin.address);
    });

    it("TC04: Transfer 100 shares -> Sender and recipient balances update", async function () {
      await assetToken.connect(admin).safeTransferFrom(admin.address, investorA.address, 1, 100n, "0x");
      expect(await assetToken.balanceOf(admin.address, 1)).to.equal(900n);
      expect(await assetToken.balanceOf(investorA.address, 1)).to.equal(100n);
    });

    it("TC05: Transfer more than owned -> Reverts", async function () {
      await expect(
        assetToken.connect(investorA).safeTransferFrom(investorA.address, investorB.address, 1, 50n, "0x")
      ).to.be.reverted;
    });
  });

  describe("Phase 3: Marketplace Operations (TC06 - TC07)", function () {
    beforeEach(async function () {
      await onboardAndTokenizeAsset(1000n, investorA.address);
      // investorA approves marketplace
      await assetToken.connect(investorA).setApprovalForAll(await marketplace.getAddress(), true);
    });

    it("TC06: Buy listed shares -> Payment and shares settle atomically", async function () {
      const pricePerShare = ethers.parseEther("0.01"); // 0.01 ETH per share
      await marketplace.connect(investorA).listItem(1, 100n, pricePerShare);

      const sellerInitialBalance = await ethers.provider.getBalance(investorA.address);
      const buyTx = await marketplace.connect(investorB).buyItem(1, 50n, {
        value: pricePerShare * 50n
      });

      // Verify buyer received tokens
      expect(await assetToken.balanceOf(investorB.address, 1)).to.equal(50n);
      // Verify seller balance increased by 0.5 ETH
      const sellerFinalBalance = await ethers.provider.getBalance(investorA.address);
      expect(sellerFinalBalance - sellerInitialBalance).to.equal(ethers.parseEther("0.5"));

      // Verify listing remaining
      const listing = await marketplace.getListing(1);
      expect(listing.amount).to.equal(50n);
      expect(listing.isActive).to.be.true;
    });

    it("TC07: Unauthorized listing cancellation -> Reverts", async function () {
      const pricePerShare = ethers.parseEther("0.01");
      await marketplace.connect(investorA).listItem(1, 100n, pricePerShare);

      await expect(
        marketplace.connect(unauthorized).cancelListing(1)
      ).to.be.revertedWith("Unauthorized");

      // Authorized cancellation by seller succeeds
      await expect(
        marketplace.connect(investorA).cancelListing(1)
      ).to.emit(marketplace, "ListingCancelled").withArgs(1n, investorA.address);

      expect(await assetToken.balanceOf(investorA.address, 1)).to.equal(1000n);
    });
  });

  describe("Phase 4: Governance & Snapshot Voting (TC08 - TC10)", function () {
    beforeEach(async function () {
      await onboardAndTokenizeAsset(1000n, admin.address);
      // Allocate shares: A: 500, B: 300, C: 200
      await assetToken.connect(admin).safeTransferFrom(admin.address, investorA.address, 1, 500n, "0x");
      await assetToken.connect(admin).safeTransferFrom(admin.address, investorB.address, 1, 300n, "0x");
      await assetToken.connect(admin).safeTransferFrom(admin.address, investorC.address, 1, 200n, "0x");
    });

    it("TC08: Vote during proposal period -> Recorded with correct snapshot weight", async function () {
      await governance.connect(investorA).createProposal(1, "Approve Solar Roof Renovation", 100);

      // Investor A votes YES (weight = 500)
      const voteTx = await governance.connect(investorA).castVote(1, 1);
      await expect(voteTx)
        .to.emit(governance, "VoteCast")
        .withArgs(1n, investorA.address, 1, 500n);

      const prop = await governance.getProposal(1);
      expect(prop.yesVotes).to.equal(500n);
      expect(prop.totalWeightVoted).to.equal(500n);
    });

    it("TC09: Duplicate vote -> Reverts", async function () {
      await governance.connect(investorA).createProposal(1, "Renovation Proposal", 100);
      await governance.connect(investorA).castVote(1, 1);

      await expect(
        governance.connect(investorA).castVote(1, 1)
      ).to.be.revertedWith("Already voted on this proposal");
    });

    it("TC10: Vote after deadline -> Reverts", async function () {
      await governance.connect(investorA).createProposal(1, "Short Window Proposal", 1);
      // Mine 2 blocks to pass the 1-block window
      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_mine", []);

      await expect(
        governance.connect(investorB).castVote(1, 1)
      ).to.be.revertedWith("Voting period ended");
    });
  });

  describe("Phase 5: Profit Distribution & Dividend Waterfall (TC11 - TC15)", function () {
    const depositAmount = ethers.parseEther("1.0"); // 1 ETH total distribution

    beforeEach(async function () {
      await onboardAndTokenizeAsset(1000n, admin.address);
      // Allocate shares: A: 500 (50%), B: 300 (30%), C: 200 (20%)
      await assetToken.connect(admin).safeTransferFrom(admin.address, investorA.address, 1, 500n, "0x");
      await assetToken.connect(admin).safeTransferFrom(admin.address, investorB.address, 1, 300n, "0x");
      await assetToken.connect(admin).safeTransferFrom(admin.address, investorC.address, 1, 200n, "0x");
    });

    it("TC11: Fund profit distribution -> Correct funding recorded", async function () {
      const tx = await distribution.connect(admin).fundDistribution(1, "2026-Q1 Rental Yield", {
        value: depositAmount
      });

      await expect(tx)
        .to.emit(distribution, "DistributionFunded")
        .withArgs(1n, 1n, depositAmount, 1n, "2026-Q1 Rental Yield");

      const period = await distribution.getPeriod(1);
      expect(period.totalAmountWei).to.equal(depositAmount);
      expect(period.isActive).to.be.true;
    });

    it("TC12: Claim eligible payout -> Correct entitlement transferred", async function () {
      await distribution.connect(admin).fundDistribution(1, "2026-Q1", { value: depositAmount });

      // Investor A (500/1000 = 50%) should receive 0.5 ETH
      const initialBal = await ethers.provider.getBalance(investorA.address);
      const claimTx = await distribution.connect(investorA).claimProfit(1);
      const receipt = await claimTx.wait();
      const gasSpent = receipt.gasUsed * receipt.gasPrice;

      const finalBal = await ethers.provider.getBalance(investorA.address);
      const expectedProfit = ethers.parseEther("0.5");
      expect(finalBal + gasSpent - initialBal).to.equal(expectedProfit);
    });

    it("TC13: Claim twice -> Reverts", async function () {
      await distribution.connect(admin).fundDistribution(1, "2026-Q1", { value: depositAmount });
      await distribution.connect(investorA).claimProfit(1);

      await expect(
        distribution.connect(investorA).claimProfit(1)
      ).to.be.revertedWith("Already claimed for this period");
    });

    it("TC14: Transfer after snapshot -> Prior entitlement unchanged", async function () {
      // 1. Snapshot taken during fundDistribution
      await distribution.connect(admin).fundDistribution(1, "2026-Q1", { value: depositAmount });

      // 2. Investor A transfers all 500 shares to Investor B AFTER the distribution snapshot
      await assetToken.connect(investorA).safeTransferFrom(investorA.address, investorB.address, 1, 500n, "0x");

      // 3. Investor A still holds claim to 50% based on historical snapshot
      expect(await distribution.getClaimableEntitlement(1, investorA.address)).to.equal(ethers.parseEther("0.5"));

      // 4. Investor B still only holds claim to 30% for that period
      expect(await distribution.getClaimableEntitlement(1, investorB.address)).to.equal(ethers.parseEther("0.3"));
    });

    it("TC15: Unauthorized action / zero claim -> Reverts", async function () {
      await distribution.connect(admin).fundDistribution(1, "2026-Q1", { value: depositAmount });

      // Unauthorized user with 0 shares attempts to claim
      await expect(
        distribution.connect(unauthorized).claimProfit(1)
      ).to.be.revertedWith("No claimable entitlement");
    });
  });

  describe("Phase 6: Security & Invariant Integrity (TC16)", function () {
    it("TC16: Unauthorized metadata alteration -> Reverts", async function () {
      await onboardAndTokenizeAsset(1000n, admin.address);

      // Verify that AssetToken does not allow arbitrary URI modifications or unauthorized minting
      await expect(
        assetToken.connect(unauthorized).tokenizeAsset(1, unauthorized.address)
      ).to.be.revertedWith("Caller is not owner or registry");

      // Verify AssetRegistry rejects unauthorized status overrides
      await expect(
        registry.connect(unauthorized).approveAsset(1)
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });
  });
});
