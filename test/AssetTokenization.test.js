const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Asset Registration and Fractional Tokenization System", function () {
  let registry, assetToken;
  let admin, issuer, investorA, investorB, unauthorized;

  const mockAsset = {
    name: "Colombo Oceanfront Residence",
    symbol: "COR-01",
    metadataURI: "ipfs://QmZtmD2qt8fJv32FNq4Lydxt5GnW372PYh13pGFrd882z",
    documentHash: "0x8f2d5e3f4b6a9c1e2d3b4a5c6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f",
    valuationLKR: 10000000n, // 10 Million LKR
    totalShares: 1000n,      // 1,000 Fractional shares (each = 0.1% = 10,000 LKR)
  };

  beforeEach(async function () {
    [admin, issuer, investorA, investorB, unauthorized] = await ethers.getSigners();

    // 1. Deploy AssetRegistry
    const AssetRegistry = await ethers.getContractFactory("AssetRegistry");
    registry = await AssetRegistry.deploy();
    await registry.waitForDeployment();

    // 2. Deploy AssetToken
    const AssetToken = await ethers.getContractFactory("AssetToken");
    assetToken = await AssetToken.deploy(await registry.getAddress());
    await assetToken.waitForDeployment();

    // 3. Link contracts
    await registry.setAssetTokenContract(await assetToken.getAddress());
  });

  describe("Phase 1: Asset Registration (AssetRegistry)", function () {
    it("TC01: Issuer registers an asset successfully in Pending state", async function () {
      const tx = await registry.connect(issuer).registerAsset(
        mockAsset.name,
        mockAsset.symbol,
        mockAsset.metadataURI,
        mockAsset.documentHash,
        mockAsset.valuationLKR,
        mockAsset.totalShares
      );
      await expect(tx)
        .to.emit(registry, "AssetRegistered")
        .withArgs(
          1n,
          issuer.address,
          mockAsset.name,
          mockAsset.valuationLKR,
          mockAsset.totalShares,
          mockAsset.metadataURI,
          mockAsset.documentHash
        );

      const record = await registry.getAsset(1);
      expect(record.name).to.equal(mockAsset.name);
      expect(record.issuer).to.equal(issuer.address);
      expect(record.valuationLKR).to.equal(mockAsset.valuationLKR);
      expect(record.totalShares).to.equal(mockAsset.totalShares);
      expect(record.status).to.equal(0); // 0 = Pending
    });

    it("TC02: Rejects registration with 0 total shares or 0 valuation", async function () {
      await expect(
        registry.connect(issuer).registerAsset(
          mockAsset.name,
          mockAsset.symbol,
          mockAsset.metadataURI,
          mockAsset.documentHash,
          0n,
          mockAsset.totalShares
        )
      ).to.be.revertedWith("Valuation must be > 0");

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

    it("TC03: Admin approves pending asset", async function () {
      await registry.connect(issuer).registerAsset(
        mockAsset.name,
        mockAsset.symbol,
        mockAsset.metadataURI,
        mockAsset.documentHash,
        mockAsset.valuationLKR,
        mockAsset.totalShares
      );

      await expect(registry.connect(admin).approveAsset(1))
        .to.emit(registry, "AssetApproved")
        .withArgs(1n, admin.address);

      expect(await registry.isAssetApproved(1)).to.be.true;
    });

    it("TC04: Non-admin cannot approve asset", async function () {
      await registry.connect(issuer).registerAsset(
        mockAsset.name,
        mockAsset.symbol,
        mockAsset.metadataURI,
        mockAsset.documentHash,
        mockAsset.valuationLKR,
        mockAsset.totalShares
      );

      await expect(
        registry.connect(unauthorized).approveAsset(1)
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });
  });

  describe("Phase 2: Fractional Tokenization (AssetToken)", function () {
    beforeEach(async function () {
      await registry.connect(issuer).registerAsset(
        mockAsset.name,
        mockAsset.symbol,
        mockAsset.metadataURI,
        mockAsset.documentHash,
        mockAsset.valuationLKR,
        mockAsset.totalShares
      );
      await registry.connect(admin).approveAsset(1);
    });

    it("TC05: Tokenizes approved asset and mints 1,000 shares to issuer", async function () {
      const tx = await assetToken.connect(admin).tokenizeAsset(1, issuer.address);

      await expect(tx)
        .to.emit(assetToken, "AssetTokenized")
        .withArgs(1n, issuer.address, mockAsset.totalShares, mockAsset.metadataURI);

      expect(await assetToken.totalShares(1)).to.equal(1000n);
      expect(await assetToken.isTokenized(1)).to.be.true;
      expect(await assetToken.balanceOf(issuer.address, 1)).to.equal(1000n);
      expect(await registry.isAssetTokenized(1)).to.be.true;
      expect(await assetToken.uri(1)).to.equal(mockAsset.metadataURI);
    });

    it("TC06: Prevents double tokenization of the same asset", async function () {
      await assetToken.connect(admin).tokenizeAsset(1, issuer.address);

      await expect(
        assetToken.connect(admin).tokenizeAsset(1, issuer.address)
      ).to.be.revertedWith("Asset already tokenized");
    });

    it("TC07: Cannot tokenize unapproved asset", async function () {
      // Register a second asset but don't approve it
      await registry.connect(issuer).registerAsset(
        "Kandy Villa",
        "KV-02",
        "ipfs://test",
        "0x123",
        5000000n,
        500n
      );

      await expect(
        assetToken.connect(admin).tokenizeAsset(2, issuer.address)
      ).to.be.revertedWith("Asset not approved in registry");
    });
  });

  describe("Phase 3: Fractional Transfers & Ownership Verification", function () {
    beforeEach(async function () {
      await registry.connect(issuer).registerAsset(
        mockAsset.name,
        mockAsset.symbol,
        mockAsset.metadataURI,
        mockAsset.documentHash,
        mockAsset.valuationLKR,
        mockAsset.totalShares
      );
      await registry.connect(admin).approveAsset(1);
      await assetToken.connect(admin).tokenizeAsset(1, issuer.address);
    });

    it("TC08: Issuer transfers fractional shares to Investor A (500) and Investor B (300)", async function () {
      // Transfer 500 to Investor A
      await assetToken.connect(issuer).safeTransferFrom(
        issuer.address,
        investorA.address,
        1,
        500n,
        "0x"
      );

      // Transfer 300 to Investor B
      await assetToken.connect(issuer).safeTransferFrom(
        issuer.address,
        investorB.address,
        1,
        300n,
        "0x"
      );

      // Investor balances:
      // Issuer: 200 (20%)
      // Investor A: 500 (50%)
      // Investor B: 300 (30%)
      expect(await assetToken.balanceOf(issuer.address, 1)).to.equal(200n);
      expect(await assetToken.balanceOf(investorA.address, 1)).to.equal(500n);
      expect(await assetToken.balanceOf(investorB.address, 1)).to.equal(300n);

      // Total conservation of shares
      const sum =
        (await assetToken.balanceOf(issuer.address, 1)) +
        (await assetToken.balanceOf(investorA.address, 1)) +
        (await assetToken.balanceOf(investorB.address, 1));
      expect(sum).to.equal(1000n);
    });

    it("TC09: Rejects transfer when sender has insufficient balance", async function () {
      await expect(
        assetToken.connect(investorA).safeTransferFrom(
          investorA.address,
          investorB.address,
          1,
          10n,
          "0x"
        )
      ).to.be.revertedWithCustomError(assetToken, "ERC1155InsufficientBalance");
    });
  });

  describe("Phase 4: Snapshot Checkpoint Support for Teammate Modules (Governance & Payouts)", function () {
    beforeEach(async function () {
      await registry.connect(issuer).registerAsset(
        mockAsset.name,
        mockAsset.symbol,
        mockAsset.metadataURI,
        mockAsset.documentHash,
        mockAsset.valuationLKR,
        mockAsset.totalShares
      );
      await registry.connect(admin).approveAsset(1);
      await assetToken.connect(admin).tokenizeAsset(1, issuer.address);

      // Distribute: Investor A has 500, Investor B has 300, Issuer has 200
      await assetToken.connect(issuer).safeTransferFrom(issuer.address, investorA.address, 1, 500n, "0x");
      await assetToken.connect(issuer).safeTransferFrom(issuer.address, investorB.address, 1, 300n, "0x");
    });

    it("TC10: Snapshot locks voting power / profit entitlement before secondary trades", async function () {
      // Admin triggers snapshot for Asset 1 (e.g. before governance vote or dividend payout)
      const tx = await assetToken.connect(admin).createSnapshot(1);
      await expect(tx).to.emit(assetToken, "SnapshotCreated").withArgs(1n, 1n, (await ethers.provider.getBlock("latest")).number);

      // Verify snapshot balances
      expect(await assetToken.balanceOfAtSnapshot(investorA.address, 1, 1)).to.equal(500n);
      expect(await assetToken.balanceOfAtSnapshot(investorB.address, 1, 1)).to.equal(300n);

      // Now Investor A transfers 200 tokens to Investor B AFTER the snapshot
      await assetToken.connect(investorA).safeTransferFrom(
        investorA.address,
        investorB.address,
        1,
        200n,
        "0x"
      );

      // Current balances changed:
      expect(await assetToken.balanceOf(investorA.address, 1)).to.equal(300n);
      expect(await assetToken.balanceOf(investorB.address, 1)).to.equal(500n);

      // But snapshot balances remain preserved! (Prevents double-voting and double-claiming)
      expect(await assetToken.balanceOfAtSnapshot(investorA.address, 1, 1)).to.equal(500n);
      expect(await assetToken.balanceOfAtSnapshot(investorB.address, 1, 1)).to.equal(300n);
    });
  });
});
