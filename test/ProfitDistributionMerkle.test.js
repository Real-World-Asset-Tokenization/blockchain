const { expect } = require("chai");
const { ethers } = require("hardhat");
const { hashLeaf, MerkleTree } = require("./helpers/merkleHelper");

describe("ProfitDistribution Contract - Merkle Settlement Suite", function () {
  let registry, assetToken, paymentToken, distribution;
  let admin, investorA, investorB, investorC, unauthorized;
  let chainId, distributionAddress;

  const mockAsset = {
    name: "Colombo Oceanfront Residence",
    symbol: "COR-01",
    metadataURI: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/colombo.json",
    documentHash: "0x9f83c6138438914b1bf0597bc5f8f5339f40feef2c95e5d326f9661d9a5b6d92",
    valuationLKR: 10000000n,
    totalShares: 1000n
  };

  // Demonstration Scenario from Section 8 of Spec:
  // Approved Distributable Profit: 100,000 units (with 6 decimals = 100,000 * 10^6)
  // Investor A: 15,000 units
  // Investor B: 5,000 units
  // Investor C (remaining holders): 80,000 units
  const TOTAL_PROFIT = ethers.parseUnits("100000", 6);
  const PAYOUT_A = ethers.parseUnits("15000", 6);
  const PAYOUT_B = ethers.parseUnits("5000", 6);
  const PAYOUT_C = ethers.parseUnits("80000", 6);

  const REPORT_HASH = ethers.keccak256(ethers.toUtf8Bytes("2026-Q1-Financial-Report-Audited"));

  let tree, leafA, leafB, leafC, proofA, proofB, proofC;

  beforeEach(async function () {
    [admin, investorA, investorB, investorC, unauthorized] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;

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

    // 4. Deploy ProfitDistribution
    const ProfitDistribution = await ethers.getContractFactory("ProfitDistribution");
    distribution = await ProfitDistribution.deploy(await assetToken.getAddress());
    await distribution.waitForDeployment();
    distributionAddress = await distribution.getAddress();

    // 5. Register and tokenize Asset 1
    await registry.registerAsset(
      mockAsset.name,
      mockAsset.symbol,
      mockAsset.metadataURI,
      mockAsset.documentHash,
      mockAsset.valuationLKR,
      mockAsset.totalShares
    );
    await registry.approveAsset(1);
    await assetToken.tokenizeAsset(1, admin.address);

    // 6. Build Merkle Tree for Round 1
    const roundId = 1n;
    leafA = hashLeaf(chainId, distributionAddress, 1n, roundId, investorA.address, PAYOUT_A);
    leafB = hashLeaf(chainId, distributionAddress, 1n, roundId, investorB.address, PAYOUT_B);
    leafC = hashLeaf(chainId, distributionAddress, 1n, roundId, investorC.address, PAYOUT_C);

    tree = new MerkleTree([leafA, leafB, leafC]);
    proofA = tree.getProof(0);
    proofB = tree.getProof(1);
    proofC = tree.getProof(2);
  });

  describe("Round Creation & Funding Lifecycle", function () {
    it("Admin creates distribution round with Merkle root and approved payout", async function () {
      const root = tree.getRoot();
      const tx = await distribution.connect(admin).createDistributionRound(
        1n,
        root,
        TOTAL_PROFIT,
        REPORT_HASH,
        await paymentToken.getAddress()
      );

      await expect(tx)
        .to.emit(distribution, "RoundCreated")
        .withArgs(1n, 1n, root, TOTAL_PROFIT, REPORT_HASH, await paymentToken.getAddress());

      const round = await distribution.getRound(1);
      expect(round.assetId).to.equal(1n);
      expect(round.merkleRoot).to.equal(root);
      expect(round.totalPayout).to.equal(TOTAL_PROFIT);
      expect(round.fundedAmount).to.equal(0n);
      expect(round.status).to.equal(1); // Approved
    });

    it("Admin deposits payment tokens to fund the round", async function () {
      await distribution.connect(admin).createDistributionRound(
        1n,
        tree.getRoot(),
        TOTAL_PROFIT,
        REPORT_HASH,
        await paymentToken.getAddress()
      );

      // Admin approves payment tokens to distribution contract
      await paymentToken.connect(admin).approve(distributionAddress, TOTAL_PROFIT);
      const tx = await distribution.connect(admin).fundDistributionRound(1n, TOTAL_PROFIT);

      await expect(tx)
        .to.emit(distribution, "RoundFunded")
        .withArgs(1n, TOTAL_PROFIT, TOTAL_PROFIT, admin.address);

      const round = await distribution.getRound(1);
      expect(round.fundedAmount).to.equal(TOTAL_PROFIT);
      expect(round.status).to.equal(2); // Funded
    });

    it("Cannot activate round before it is fully funded", async function () {
      await distribution.connect(admin).createDistributionRound(
        1n,
        tree.getRoot(),
        TOTAL_PROFIT,
        REPORT_HASH,
        await paymentToken.getAddress()
      );

      await expect(
        distribution.connect(admin).activateDistributionRound(1n)
      ).to.be.revertedWith("Round must be fully funded before activation");
    });

    it("Admin activates fully funded distribution round", async function () {
      await distribution.connect(admin).createDistributionRound(
        1n,
        tree.getRoot(),
        TOTAL_PROFIT,
        REPORT_HASH,
        await paymentToken.getAddress()
      );

      await paymentToken.connect(admin).approve(distributionAddress, TOTAL_PROFIT);
      await distribution.connect(admin).fundDistributionRound(1n, TOTAL_PROFIT);

      const tx = await distribution.connect(admin).activateDistributionRound(1n);
      await expect(tx).to.emit(distribution, "RoundActivated");

      const round = await distribution.getRound(1);
      expect(round.status).to.equal(3); // Active
    });
  });

  describe("Claim Verification and Settlement", function () {
    beforeEach(async function () {
      await distribution.connect(admin).createDistributionRound(
        1n,
        tree.getRoot(),
        TOTAL_PROFIT,
        REPORT_HASH,
        await paymentToken.getAddress()
      );

      await paymentToken.connect(admin).approve(distributionAddress, TOTAL_PROFIT);
      await distribution.connect(admin).fundDistributionRound(1n, TOTAL_PROFIT);
      await distribution.connect(admin).activateDistributionRound(1n);
    });

    it("Investor A claims their 15,000 mUSD entitlement with valid Merkle proof", async function () {
      const initialBal = await paymentToken.balanceOf(investorA.address);

      const tx = await distribution.connect(investorA).claimProfit(1n, PAYOUT_A, proofA);

      await expect(tx)
        .to.emit(distribution, "ProfitClaimed")
        .withArgs(1n, 1n, investorA.address, PAYOUT_A);

      const finalBal = await paymentToken.balanceOf(investorA.address);
      expect(finalBal - initialBal).to.equal(PAYOUT_A);

      expect(await distribution.isClaimed(1n, investorA.address)).to.be.true;

      const round = await distribution.getRound(1);
      expect(round.claimedAmount).to.equal(PAYOUT_A);
    });

    it("Investor B claims their 5,000 mUSD entitlement", async function () {
      const initialBal = await paymentToken.balanceOf(investorB.address);

      await distribution.connect(investorB).claimProfit(1n, PAYOUT_B, proofB);

      const finalBal = await paymentToken.balanceOf(investorB.address);
      expect(finalBal - initialBal).to.equal(PAYOUT_B);
    });

    it("Reverts duplicate claim attempt (double-claim prevention)", async function () {
      await distribution.connect(investorA).claimProfit(1n, PAYOUT_A, proofA);

      await expect(
        distribution.connect(investorA).claimProfit(1n, PAYOUT_A, proofA)
      ).to.be.revertedWith("Profit already claimed for this round");
    });

    it("Reverts claim with modified payout amount (fraud prevention)", async function () {
      const inflatedPayout = PAYOUT_A + ethers.parseUnits("1", 6);

      await expect(
        distribution.connect(investorA).claimProfit(1n, inflatedPayout, proofA)
      ).to.be.revertedWith("Invalid Merkle proof or incorrect claim entitlement");
    });

    it("Reverts claim with invalid proof", async function () {
      // Investor A attempts to use proof B
      await expect(
        distribution.connect(investorA).claimProfit(1n, PAYOUT_A, proofB)
      ).to.be.revertedWith("Invalid Merkle proof or incorrect claim entitlement");
    });

    it("Reverts claim from unauthorized wallet using another investor's proof", async function () {
      await expect(
        distribution.connect(unauthorized).claimProfit(1n, PAYOUT_A, proofA)
      ).to.be.revertedWith("Invalid Merkle proof or incorrect claim entitlement");
    });

    it("Reverts cross-round proof replay", async function () {
      // Create Round 2 with dummy root
      await distribution.connect(admin).createDistributionRound(
        1n,
        ethers.keccak256(ethers.toUtf8Bytes("dummy-root")),
        TOTAL_PROFIT,
        REPORT_HASH,
        await paymentToken.getAddress()
      );
      await paymentToken.connect(admin).approve(distributionAddress, TOTAL_PROFIT);
      await distribution.connect(admin).fundDistributionRound(2n, TOTAL_PROFIT);
      await distribution.connect(admin).activateDistributionRound(2n);

      // Attempt to use Round 1 proof on Round 2
      await expect(
        distribution.connect(investorA).claimProfit(2n, PAYOUT_A, proofA)
      ).to.be.revertedWith("Invalid Merkle proof or incorrect claim entitlement");
    });
  });

  describe("Round Closure and Leftover Fund Recovery", function () {
    beforeEach(async function () {
      await distribution.connect(admin).createDistributionRound(
        1n,
        tree.getRoot(),
        TOTAL_PROFIT,
        REPORT_HASH,
        await paymentToken.getAddress()
      );

      await paymentToken.connect(admin).approve(distributionAddress, TOTAL_PROFIT);
      await distribution.connect(admin).fundDistributionRound(1n, TOTAL_PROFIT);
      await distribution.connect(admin).activateDistributionRound(1n);

      // Only Investor A claims
      await distribution.connect(investorA).claimProfit(1n, PAYOUT_A, proofA);
    });

    it("Admin closes round and recovers unclaimed funds safely", async function () {
      const initialAdminBal = await paymentToken.balanceOf(admin.address);
      const expectedUnclaimed = TOTAL_PROFIT - PAYOUT_A;

      const tx = await distribution.connect(admin).closeDistributionRound(1n);
      await expect(tx)
        .to.emit(distribution, "RoundClosed")
        .withArgs(1n, expectedUnclaimed);

      const finalAdminBal = await paymentToken.balanceOf(admin.address);
      expect(finalAdminBal - initialAdminBal).to.equal(expectedUnclaimed);

      const round = await distribution.getRound(1);
      expect(round.status).to.equal(4); // Closed
    });

    it("Investor cannot claim from a closed round", async function () {
      await distribution.connect(admin).closeDistributionRound(1n);

      await expect(
        distribution.connect(investorB).claimProfit(1n, PAYOUT_B, proofB)
      ).to.be.revertedWith("Distribution round is not active");
    });
  });
});
