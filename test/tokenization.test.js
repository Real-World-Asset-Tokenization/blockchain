const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Asset Tokenization Module — Smart Contract & Pricing Verification", function () {
  let registry, assetToken, paymentToken, marketplace;
  let admin, verifier, issuer, investorA, investorB, unauthorized;

  const mockAsset = {
    name: "Colombo Oceanfront Residence",
    symbol: "COR-01",
    metadataURI: "ipfs://QmZtmD2qt8fJv32FNq4Lydxt5GnW372PYh13pGFrd882z",
    documentHash: "0x8f2d5e3f4b6a9c1e2d3b4a5c6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f",
    valuationLKR: 10000000n, // LKR 10,000,000
    totalShares: 1000n,      // 1,000 tokens (Reference price = 10,000 LKR)
  };

  beforeEach(async function () {
    [admin, verifier, issuer, investorA, investorB, unauthorized] = await ethers.getSigners();

    // 1. Deploy AssetRegistry
    const AssetRegistry = await ethers.getContractFactory("AssetRegistry");
    registry = await AssetRegistry.deploy();
    await registry.waitForDeployment();

    // 2. Deploy AssetToken
    const AssetToken = await ethers.getContractFactory("AssetToken");
    assetToken = await AssetToken.deploy(await registry.getAddress());
    await assetToken.waitForDeployment();

    // 3. Link Registry with AssetToken
    await registry.setAssetTokenContract(await assetToken.getAddress());

    // 4. Configure Authorized Verifier
    await registry.setAuthorizedVerifier(verifier.address, true);

    // 5. Deploy MockPaymentToken & TokenMarketplace for trading integration tests
    const MockPaymentToken = await ethers.getContractFactory("MockPaymentToken");
    paymentToken = await MockPaymentToken.deploy("Mock USD", "mUSD", 6);
    await paymentToken.waitForDeployment();

    const TokenMarketplace = await ethers.getContractFactory("TokenMarketplace");
    marketplace = await TokenMarketplace.deploy(
      await assetToken.getAddress(),
      admin.address, // platform fee treasury
      250 // 2.5% fee
    );
    await marketplace.waitForDeployment();
  });

  describe("Scenario 1: Successful Owner-Initiated Tokenization", function () {
    it("Mints exactly 1,000 tokens to approved owner, records on-chain status, and sets reference price", async function () {
      // Step 1: Register asset
      await registry.connect(issuer).registerAsset(
        mockAsset.name,
        mockAsset.symbol,
        mockAsset.metadataURI,
        mockAsset.documentHash,
        mockAsset.valuationLKR,
        mockAsset.totalShares
      );

      // Step 2: Verification component approves asset
      await registry.connect(verifier).approveAsset(1);
      expect(await registry.isAssetApproved(1)).to.be.true;

      // Step 3: Owner checks initial reference price before tokenization
      const initialRefPrice = await registry.getInitialReferencePrice(1);
      expect(initialRefPrice).to.equal(10000n); // 10,000,000 / 1,000 = 10,000 LKR

      // Step 4: Asset owner initiates tokenization directly via MetaMask / contract
      const tx = await assetToken.connect(issuer).tokenize(1);
      const receipt = await tx.wait();

      // Gas measurement
      console.log(`      Gas used for owner-initiated tokenization: ${receipt.gasUsed.toString()} units`);

      // Verify event
      await expect(tx)
        .to.emit(assetToken, "AssetTokenized")
        .withArgs(1n, issuer.address, 1000n, mockAsset.metadataURI);

      // Verify balance
      expect(await assetToken.balanceOf(issuer.address, 1)).to.equal(1000n);
      expect(await assetToken.totalShares(1)).to.equal(1000n);
      expect(await assetToken.isTokenized(1)).to.be.true;

      // Verify on-chain registry status
      expect(await registry.isAssetTokenized(1)).to.be.true;
      const assetRecord = await registry.getAsset(1);
      expect(assetRecord.status).to.equal(2); // 2 = Tokenized
      expect(assetRecord.tokenizedAt).to.be.gt(0);

      // Verify reference price from AssetToken
      expect(await assetToken.getInitialReferencePrice(1)).to.equal(10000n);
    });
  });

  describe("Scenario 2: Duplicate Tokenization Prevention", function () {
    it("Rejects repeated tokenization attempts on an already tokenized asset", async function () {
      await registry.connect(issuer).registerAsset(
        mockAsset.name,
        mockAsset.symbol,
        mockAsset.metadataURI,
        mockAsset.documentHash,
        mockAsset.valuationLKR,
        mockAsset.totalShares
      );
      await registry.connect(verifier).approveAsset(1);
      await assetToken.connect(issuer).tokenize(1);

      // Attempt second tokenization
      await expect(
        assetToken.connect(issuer).tokenize(1)
      ).to.be.revertedWith("Asset already tokenized");
    });
  });

  describe("Scenario 3: Unverified Asset Tokenization Prevention", function () {
    it("Rejects tokenization when asset is still in Pending state", async function () {
      await registry.connect(issuer).registerAsset(
        mockAsset.name,
        mockAsset.symbol,
        mockAsset.metadataURI,
        mockAsset.documentHash,
        mockAsset.valuationLKR,
        mockAsset.totalShares
      );
      // Not approved yet!
      await expect(
        assetToken.connect(issuer).tokenize(1)
      ).to.be.revertedWith("Asset not approved in registry");
    });
  });

  describe("Scenario 4: Unauthorized Owner Prevention", function () {
    it("Rejects tokenization attempt by an unauthorized third-party wallet", async function () {
      await registry.connect(issuer).registerAsset(
        mockAsset.name,
        mockAsset.symbol,
        mockAsset.metadataURI,
        mockAsset.documentHash,
        mockAsset.valuationLKR,
        mockAsset.totalShares
      );
      await registry.connect(verifier).approveAsset(1);

      // Unauthorized user tries to tokenize issuer's asset
      await expect(
        assetToken.connect(unauthorized).tokenize(1)
      ).to.be.revertedWith("Caller is not authorized asset owner or admin");
    });
  });

  describe("Scenario 5: Supply Enforcement & Recipient Tampering Prevention", function () {
    it("Rejects tokenization if recipient differs from verified asset owner", async function () {
      await registry.connect(issuer).registerAsset(
        mockAsset.name,
        mockAsset.symbol,
        mockAsset.metadataURI,
        mockAsset.documentHash,
        mockAsset.valuationLKR,
        mockAsset.totalShares
      );
      await registry.connect(verifier).approveAsset(1);

      // Attempt by issuer to divert minted tokens to unauthorized address
      await expect(
        assetToken.connect(issuer).tokenizeAsset(1, unauthorized.address)
      ).to.be.revertedWith("Recipient must be verified asset owner");
    });
  });

  describe("Scenario 6: Invalid or Revoked Approval Rejection", function () {
    it("Rejects tokenization if the verification component rejected the asset", async function () {
      await registry.connect(issuer).registerAsset(
        mockAsset.name,
        mockAsset.symbol,
        mockAsset.metadataURI,
        mockAsset.documentHash,
        mockAsset.valuationLKR,
        mockAsset.totalShares
      );

      // Verifier rejects deed verification
      await registry.connect(verifier).rejectAsset(1, "Deed registry mismatch");
      const asset = await registry.getAsset(1);
      expect(asset.status).to.equal(3); // 3 = Rejected

      // Attempt to tokenize rejected asset
      await expect(
        assetToken.connect(issuer).tokenize(1)
      ).to.be.revertedWith("Asset not approved in registry");
    });
  });

  describe("Scenario 7: Authoritative Ownership Balance Verification", function () {
    it("Accurately verifies wallet token balances on blockchain", async function () {
      await registry.connect(issuer).registerAsset(
        mockAsset.name,
        mockAsset.symbol,
        mockAsset.metadataURI,
        mockAsset.documentHash,
        mockAsset.valuationLKR,
        mockAsset.totalShares
      );
      await registry.connect(verifier).approveAsset(1);
      await assetToken.connect(issuer).tokenize(1);

      // Owner has 1,000, others have 0
      expect(await assetToken.balanceOf(issuer.address, 1)).to.equal(1000n);
      expect(await assetToken.balanceOf(investorA.address, 1)).to.equal(0n);
      expect(await assetToken.balanceOf(investorB.address, 1)).to.equal(0n);
    });
  });

  describe("Scenario 8: Marketplace Ownership Transfers", function () {
    it("Transfers 100 tokens to investor, leaving owner with 900 and total supply at 1,000", async function () {
      await registry.connect(issuer).registerAsset(
        mockAsset.name,
        mockAsset.symbol,
        mockAsset.metadataURI,
        mockAsset.documentHash,
        mockAsset.valuationLKR,
        mockAsset.totalShares
      );
      await registry.connect(verifier).approveAsset(1);
      await assetToken.connect(issuer).tokenize(1);

      // Direct ERC-1155 transfer or marketplace trade
      await assetToken.connect(issuer).safeTransferFrom(
        issuer.address,
        investorA.address,
        1,
        100n,
        "0x"
      );

      expect(await assetToken.balanceOf(issuer.address, 1)).to.equal(900n);
      expect(await assetToken.balanceOf(investorA.address, 1)).to.equal(100n);
      expect(await assetToken.totalShares(1)).to.equal(1000n);
    });
  });

  describe("Scenario 9: Reference Valuation Update (Dual-Price Model)", function () {
    it("Updates approved valuation from 10M to 12M LKR: reference price updates to 12,000 LKR without changing token balances or supply", async function () {
      await registry.connect(issuer).registerAsset(
        mockAsset.name,
        mockAsset.symbol,
        mockAsset.metadataURI,
        mockAsset.documentHash,
        mockAsset.valuationLKR,
        mockAsset.totalShares
      );
      await registry.connect(verifier).approveAsset(1);
      await assetToken.connect(issuer).tokenize(1);

      // Transfer 100 tokens to investor A
      await assetToken.connect(issuer).safeTransferFrom(issuer.address, investorA.address, 1, 100n, "0x");

      // Initial reference price was 10,000
      expect(await assetToken.getInitialReferencePrice(1)).to.equal(10000n);

      // Verifier updates valuation to LKR 12,000,000
      const updateTx = await registry.connect(verifier).updateAssetValuation(1, 12000000n);
      await expect(updateTx)
        .to.emit(registry, "AssetValuationUpdated")
        .withArgs(1n, 12000000n, 10000000n, (await ethers.provider.getBlock("latest")).timestamp);

      // Reference price is now 12,000 LKR (12,000,000 / 1,000)
      expect(await assetToken.getInitialReferencePrice(1)).to.equal(12000n);

      // Invariant checks: balances and total supply remain UNCHANGED
      expect(await assetToken.balanceOf(issuer.address, 1)).to.equal(900n);
      expect(await assetToken.balanceOf(investorA.address, 1)).to.equal(100n);
      expect(await assetToken.totalShares(1)).to.equal(1000n);
    });
  });

  describe("Scenario 10: Market Price Independence vs Reference Price", function () {
    it("Market trades occur at LKR 15,000 while Reference Price remains independently anchored at valuation", async function () {
      await registry.connect(issuer).registerAsset(
        mockAsset.name,
        mockAsset.symbol,
        mockAsset.metadataURI,
        mockAsset.documentHash,
        mockAsset.valuationLKR,
        mockAsset.totalShares
      );
      await registry.connect(verifier).approveAsset(1);
      await assetToken.connect(issuer).tokenize(1);

      // Setup investor B with funds
      const pricePerToken = 15000000000n; // 15,000 mUSD (scaled 6 decimals)
      await paymentToken.mint(investorB.address, 1000000000000n);
      await paymentToken.connect(investorB).approve(await marketplace.getAddress(), ethers.MaxUint256);

      // Issuer approves marketplace and creates listing for 50 tokens at 15,000 each
      await assetToken.connect(issuer).setApprovalForAll(await marketplace.getAddress(), true);
      const listingTx = await marketplace.connect(issuer).createListing(
        1,
        50n,
        pricePerToken,
        await paymentToken.getAddress(),
        86400
      );
      await expect(listingTx).to.emit(marketplace, "ListingCreated");

      // Investor B buys the active listing of 50 tokens at market price of 15,000
      const buyTx = await marketplace.connect(investorB).buyListing(1);
      await expect(buyTx).to.emit(marketplace, "ListingPurchased");

      // Investor B now holds 50 tokens from secondary trade
      expect(await assetToken.balanceOf(investorB.address, 1)).to.equal(50n);
      expect(await assetToken.balanceOf(issuer.address, 1)).to.equal(950n);

      // Dual-price validation: Reference price remains strictly 10,000 LKR (valuation-derived), completely unaffected by market trade
      const refPrice = await assetToken.getInitialReferencePrice(1);
      expect(refPrice).to.equal(10000n);
    });
  });

  describe("Scenario 11: Transaction Failure, Reentrancy, and Access Control Security", function () {
    it("Prevents non-verifiers from updating asset valuations or self-approving assets", async function () {
      await registry.connect(issuer).registerAsset(
        mockAsset.name,
        mockAsset.symbol,
        mockAsset.metadataURI,
        mockAsset.documentHash,
        mockAsset.valuationLKR,
        mockAsset.totalShares
      );

      // Issuer attempts to self-approve
      await expect(
        registry.connect(issuer).approveAsset(1)
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");

      // Unauthorized attempts to update valuation
      await expect(
        registry.connect(unauthorized).updateAssetValuation(1, 50000000n)
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });
  });
});
