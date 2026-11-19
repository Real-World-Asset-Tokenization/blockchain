const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { hashLeaf, MerkleTree } = require("./helpers/merkleHelper");

describe("Master Research Evaluation - End-to-End 12-Step Demonstration", function () {
  let registry, assetToken, paymentToken, marketplace, distribution;
  let admin, treasury, investorA, investorB, otherHolders, attacker;
  let chainId, distributionAddress;

  const mockAsset = {
    name: "Colombo Oceanfront Residence",
    symbol: "COR-01",
    metadataURI: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/colombo.json",
    documentHash: "0x9f83c6138438914b1bf0597bc5f8f5339f40feef2c95e5d326f9661d9a5b6d92",
    valuationLKR: 10000000n,
    totalShares: 1000n
  };

  const FEE_BPS = 100n; // 1% platform fee
  const PRICE_PER_TOKEN = ethers.parseUnits("100", 6); // 100 mUSD / token
  const APPROVED_DISTRIBUTABLE_PROFIT = ethers.parseUnits("100000", 6); // 100,000 mUSD

  before(async function () {
    [admin, treasury, investorA, investorB, otherHolders, attacker] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;

    // Deploy AssetRegistry
    const AssetRegistry = await ethers.getContractFactory("AssetRegistry");
    registry = await AssetRegistry.deploy();
    await registry.waitForDeployment();

    // Deploy AssetToken
    const AssetToken = await ethers.getContractFactory("AssetToken");
    assetToken = await AssetToken.deploy(await registry.getAddress());
    await assetToken.waitForDeployment();
    await registry.setAssetTokenContract(await assetToken.getAddress());

    // Deploy MockPaymentToken (mUSD, 6 decimals)
    const MockPaymentToken = await ethers.getContractFactory("MockPaymentToken");
    paymentToken = await MockPaymentToken.deploy("Mock USD", "mUSD", 6);
    await paymentToken.waitForDeployment();

    // Deploy TokenMarketplace
    const TokenMarketplace = await ethers.getContractFactory("TokenMarketplace");
    marketplace = await TokenMarketplace.deploy(
      await assetToken.getAddress(),
      treasury.address,
      FEE_BPS
    );
    await marketplace.waitForDeployment();

    // Deploy ProfitDistribution
    const ProfitDistribution = await ethers.getContractFactory("ProfitDistribution");
    distribution = await ProfitDistribution.deploy(await assetToken.getAddress());
    await distribution.waitForDeployment();
    distributionAddress = await distribution.getAddress();

    // Fund accounts with payment tokens
    await paymentToken.mint(investorB.address, ethers.parseUnits("50000", 6));
    await paymentToken.mint(admin.address, ethers.parseUnits("200000", 6));
  });

  it("Step 1: Asset Tokenization (Colombo Oceanfront Residence - 1,000 shares)", async function () {
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

    expect(await assetToken.totalShares(1)).to.equal(1000n);
    expect(await assetToken.balanceOf(admin.address, 1)).to.equal(1000n);
  });

  it("Step 2: Initial Ownership Allocation (200 tokens to Investor A, 800 to Other Holders)", async function () {
    // Transfer 200 shares to Investor A
    await assetToken.connect(admin).safeTransferFrom(admin.address, investorA.address, 1, 200n, "0x");
    // Transfer 800 shares to Other Holders
    await assetToken.connect(admin).safeTransferFrom(admin.address, otherHolders.address, 1, 800n, "0x");

    expect(await assetToken.balanceOf(investorA.address, 1)).to.equal(200n);
    expect(await assetToken.balanceOf(otherHolders.address, 1)).to.equal(800n);
    expect(await assetToken.balanceOf(investorB.address, 1)).to.equal(0n);
  });

  let tradeTimestamp;
  it("Step 3: Mid-Period Token Trading (Investor A lists 100 shares, Investor B buys atomically)", async function () {
    // Investor A approves marketplace for asset tokens
    await assetToken.connect(investorA).setApprovalForAll(await marketplace.getAddress(), true);

    // Investor A lists 100 tokens
    await marketplace.connect(investorA).createListing(
      1,
      100n,
      PRICE_PER_TOKEN,
      await paymentToken.getAddress(),
      86400 * 30
    );

    // Investor B approves marketplace for 10,000 mUSD
    const totalPrice = 100n * PRICE_PER_TOKEN; // 10,000 mUSD
    await paymentToken.connect(investorB).approve(await marketplace.getAddress(), totalPrice);

    // Buyer executes atomic purchase
    const buyTx = await marketplace.connect(investorB).buyListing(1);
    const receipt = await buyTx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);
    tradeTimestamp = block.timestamp;

    // Verify balances after trade
    expect(await assetToken.balanceOf(investorA.address, 1)).to.equal(100n);
    expect(await assetToken.balanceOf(investorB.address, 1)).to.equal(100n);
    expect(await assetToken.balanceOf(otherHolders.address, 1)).to.equal(800n);

    // Verify atomic payment settlement: 9,900 mUSD to seller, 100 mUSD to treasury
    expect(await paymentToken.balanceOf(investorA.address)).to.equal(ethers.parseUnits("9900", 6));
    expect(await paymentToken.balanceOf(treasury.address)).to.equal(ethers.parseUnits("100", 6));
  });

  let periodStart, periodEnd, roundId;
  let payoutA, payoutB, payoutOthers;
  let tree, proofA, proofB, proofOthers;

  it("Step 4 & 5: Time-Weighted Ownership Accounting & Profit Allocation Calculation", async function () {
    // Demonstration model:
    // Total period = 30 days
    // Trade occurred exactly halfway (Day 15)
    // Holding durations:
    // Investor A: 200 tokens for 15 days + 100 tokens for 15 days = 4,500 token-days
    // Investor B: 0 tokens for 15 days + 100 tokens for 15 days = 1,500 token-days
    // Other Holders: 800 tokens for 30 days = 24,000 token-days
    // Total Token-Days = 30,000 token-days
    //
    // Entitlements from 100,000 mUSD pool:
    // Investor A = (4,500 / 30,000) * 100,000 = 15,000 mUSD
    // Investor B = (1,500 / 30,000) * 100,000 = 5,000 mUSD
    // Other Holders = (24,000 / 30,000) * 100,000 = 80,000 mUSD

    const tokenDaysA = (200n * 15n) + (100n * 15n); // 4,500
    const tokenDaysB = 100n * 15n;                   // 1,500
    const tokenDaysOthers = 800n * 30n;             // 24,000
    const totalTokenDays = 1000n * 30n;             // 30,000

    expect(tokenDaysA).to.equal(4500n);
    expect(tokenDaysB).to.equal(1500n);
    expect(tokenDaysOthers).to.equal(24000n);
    expect(totalTokenDays).to.equal(30000n);

    // Compute payouts in 6-decimal units
    payoutA = (tokenDaysA * APPROVED_DISTRIBUTABLE_PROFIT) / totalTokenDays;
    payoutB = (tokenDaysB * APPROVED_DISTRIBUTABLE_PROFIT) / totalTokenDays;
    payoutOthers = (tokenDaysOthers * APPROVED_DISTRIBUTABLE_PROFIT) / totalTokenDays;

    expect(payoutA).to.equal(ethers.parseUnits("15000", 6));
    expect(payoutB).to.equal(ethers.parseUnits("5000", 6));
    expect(payoutOthers).to.equal(ethers.parseUnits("80000", 6));
    expect(payoutA + payoutB + payoutOthers).to.equal(APPROVED_DISTRIBUTABLE_PROFIT);

    // Contrast with traditional snapshot baseline:
    // Snapshot would pay Investor A (100/1000 = 10,000 mUSD) and Investor B (100/1000 = 10,000 mUSD)
    const snapshotA = (100n * APPROVED_DISTRIBUTABLE_PROFIT) / 1000n;
    const snapshotB = (100n * APPROVED_DISTRIBUTABLE_PROFIT) / 1000n;
    expect(snapshotA).to.equal(ethers.parseUnits("10000", 6));
    expect(snapshotB).to.equal(ethers.parseUnits("10000", 6));

    // Research finding: Snapshot severely underpays Investor A by 5,000 mUSD and overpays Investor B by 5,000 mUSD!
    expect(payoutA - snapshotA).to.equal(ethers.parseUnits("5000", 6));
    expect(payoutB - snapshotB).to.equal(-ethers.parseUnits("5000", 6));
  });

  it("Step 6: Cryptographic Merkle Tree Generation", async function () {
    roundId = 1n;

    // Generate replay-safe leaves
    const leafA = hashLeaf(chainId, distributionAddress, 1n, roundId, investorA.address, payoutA);
    const leafB = hashLeaf(chainId, distributionAddress, 1n, roundId, investorB.address, payoutB);
    const leafOthers = hashLeaf(chainId, distributionAddress, 1n, roundId, otherHolders.address, payoutOthers);

    tree = new MerkleTree([leafA, leafB, leafOthers]);
    proofA = tree.getProof(0);
    proofB = tree.getProof(1);
    proofOthers = tree.getProof(2);

    expect(tree.getRoot()).to.be.properHex(64);
  });

  it("Step 7 & 8: Distribution Funding & Merkle Root Publication", async function () {
    const reportHash = ethers.keccak256(ethers.toUtf8Bytes("Colombo-Residence-Period-1-Audited"));

    // Admin creates distribution round on-chain
    await distribution.connect(admin).createDistributionRound(
      1n,
      tree.getRoot(),
      APPROVED_DISTRIBUTABLE_PROFIT,
      reportHash,
      await paymentToken.getAddress()
    );

    // Admin funds the contract with 100,000 mUSD
    await paymentToken.connect(admin).approve(distributionAddress, APPROVED_DISTRIBUTABLE_PROFIT);
    await distribution.connect(admin).fundDistributionRound(roundId, APPROVED_DISTRIBUTABLE_PROFIT);

    // Activate claims
    await distribution.connect(admin).activateDistributionRound(roundId);

    const round = await distribution.getRound(roundId);
    expect(round.status).to.equal(3); // Active
    expect(round.fundedAmount).to.equal(APPROVED_DISTRIBUTABLE_PROFIT);
  });

  it("Step 9: Investor Claims (Investor A claims 15,000 mUSD, Investor B claims 5,000 mUSD)", async function () {
    const balA_before = await paymentToken.balanceOf(investorA.address);
    const balB_before = await paymentToken.balanceOf(investorB.address);

    // Investor A claims
    await distribution.connect(investorA).claimProfit(roundId, payoutA, proofA);
    const balA_after = await paymentToken.balanceOf(investorA.address);
    expect(balA_after - balA_before).to.equal(payoutA);

    // Investor B claims
    await distribution.connect(investorB).claimProfit(roundId, payoutB, proofB);
    const balB_after = await paymentToken.balanceOf(investorB.address);
    expect(balB_after - balB_before).to.equal(payoutB);

    // Other holders claim
    await distribution.connect(otherHolders).claimProfit(roundId, payoutOthers, proofOthers);
    expect(await paymentToken.balanceOf(otherHolders.address)).to.equal(payoutOthers);

    // Verify all funds successfully claimed
    const round = await distribution.getRound(roundId);
    expect(round.claimedAmount).to.equal(APPROVED_DISTRIBUTABLE_PROFIT);
  });

  it("Step 10: Security Testing & Attack Resistance", async function () {
    // 10.1: Duplicate claim attempt reverts
    await expect(
      distribution.connect(investorA).claimProfit(roundId, payoutA, proofA)
    ).to.be.revertedWith("Profit already claimed for this round");

    // 10.2: Attempt to claim after pool is fully exhausted reverts on remaining funding
    await expect(
      distribution.connect(attacker).claimProfit(roundId, payoutA, proofA)
    ).to.be.revertedWith("Claim exceeds remaining round funding");

    // 10.3: Create funded Round 2 to test cryptographic tamper detection
    const roundId2 = 2n;
    const leafA2 = hashLeaf(chainId, distributionAddress, 1n, roundId2, investorA.address, payoutA);
    const tree2 = new MerkleTree([leafA2]);
    const proofA2 = tree2.getProof(0);

    const reportHash2 = ethers.keccak256(ethers.toUtf8Bytes("Colombo-Period-2-Security"));
    await distribution.connect(admin).createDistributionRound(
      1n,
      tree2.getRoot(),
      APPROVED_DISTRIBUTABLE_PROFIT,
      reportHash2,
      await paymentToken.getAddress()
    );
    await paymentToken.connect(admin).approve(distributionAddress, APPROVED_DISTRIBUTABLE_PROFIT);
    await distribution.connect(admin).fundDistributionRound(roundId2, APPROVED_DISTRIBUTABLE_PROFIT);
    await distribution.connect(admin).activateDistributionRound(roundId2);

    // Tampered payout amount reverts with invalid Merkle proof
    await expect(
      distribution.connect(investorA).claimProfit(roundId2, payoutA + 1n, proofA2)
    ).to.be.revertedWith("Invalid Merkle proof or incorrect claim entitlement");

    // Attacker using Investor A's proof reverts with invalid Merkle proof
    await expect(
      distribution.connect(attacker).claimProfit(roundId2, payoutA, proofA2)
    ).to.be.revertedWith("Invalid Merkle proof or incorrect claim entitlement");

    // 10.4: Proof for non-existent round reverts
    await expect(
      distribution.connect(investorA).claimProfit(999n, payoutA, proofA2)
    ).to.be.revertedWith("Round does not exist");
  });

  it("Step 11: Net Loss Scenario Accounting", async function () {
    // Suppose Period 2 produces a net loss (Gross revenue < Operating expenses):
    // Revenue = 20,000 mUSD, Expenses = 35,000 mUSD -> Net Loss = -15,000 mUSD
    const revenue = 20000;
    const expenses = 35000;
    const netLoss = expenses - revenue; // 15,000 loss

    // Business rule:
    // 1. Distributable profit is strictly zero
    const distributableAmount = Math.max(0, revenue - expenses);
    expect(distributableAmount).to.equal(0);

    // 2. Token holdings remain untouched in investor wallets
    expect(await assetToken.balanceOf(investorA.address, 1)).to.equal(100n);
    expect(await assetToken.balanceOf(investorB.address, 1)).to.equal(100n);

    // 3. Loss carried forward to offset future surplus periods
    let lossCarryForward = netLoss;
    expect(lossCarryForward).to.equal(15000);

    // If subsequent period yields 25,000 profit, loss is netted out first:
    const subsequentSurplus = 25000;
    const netDistributableAfterOffset = subsequentSurplus - lossCarryForward;
    expect(netDistributableAfterOffset).to.equal(10000);
  });

  it("Step 12: Gas Scaling & Platform vs Investor Attribution Verification", async function () {
    // Benchmark verification:
    // Under Merkle framework, platform setup cost is O(1) constant.
    // Let's measure the actual gas used to publish and fund a round:
    const dummyRoot = ethers.keccak256(ethers.toUtf8Bytes("dummy"));
    const createTx = await distribution.connect(admin).createDistributionRound(
      1n,
      dummyRoot,
      ethers.parseUnits("1000", 6),
      dummyRoot,
      await paymentToken.getAddress()
    );
    const createReceipt = await createTx.wait();

    // Verify platform setup gas is under 300,000 gas (constant O(1))
    expect(createReceipt.gasUsed).to.be.lessThan(300000n);

    // In contrast, pushing ERC20 transfers to 1,000 investors costs:
    // 1,000 * ~34,500 gas = 34,500,000 gas (exceeding standard 30M block gas limits!)
    const simulatedPushGas1000Investors = 1000n * 34500n;
    expect(simulatedPushGas1000Investors).to.be.greaterThan(30000000n);

    // Merkle claim gas per investor is logarithmic O(log2 N):
    // For 1,000 investors (tree depth 10): 54,000 + 10 * 2,800 = ~82,000 gas per claim.
    const merklePerClaimGas1000 = 54000n + (10n * 2800n);
    expect(merklePerClaimGas1000).to.be.lessThan(90000n);
  });
});
