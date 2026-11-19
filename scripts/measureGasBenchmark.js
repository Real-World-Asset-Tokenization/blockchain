/**
 * Measures real gas for distributing profit to N investors with three methods and writes
 * the result to the backend (src/contracts/gasBenchmark.json), which serves /api/gas/benchmark.
 *
 *   Merkle   : ProfitDistribution (create + approve + fund + activate, then N claims with proofs)
 *   Push     : the platform sends an ERC20 transfer to each of the N investors
 *   Snapshot : SnapshotProfitDistribution (fundDistribution, then N pull claims)
 *
 * Run: npx hardhat run scripts/measureGasBenchmark.js
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { hashLeaf, MerkleTree } = require("../test/helpers/merkleHelper");

const COHORTS = [10, 100, 500, 1000];
const SHARES_PER_HOLDER = 10n;
const PAYOUT_PER_HOLDER = ethers.parseUnits("1", 6); // 1 mUSD
const OUTPUT = path.join(__dirname, "../../asset-tokenization-backend/src/contracts/gasBenchmark.json");

const sum = (list) => list.reduce((a, b) => a + b, 0n);
const percentLess = (base, value) => Number(((base - value) * 10000n) / base) / 100;

async function gasOf(txPromise) {
  const receipt = await (await txPromise).wait();
  return receipt.gasUsed;
}

async function measureCohort(n, admin) {
  const nBig = BigInt(n);
  const chainId = (await ethers.provider.getNetwork()).chainId;

  // Fresh contracts per cohort so cohorts cannot affect each other.
  const registry = await (await ethers.getContractFactory("AssetRegistry")).deploy();
  const assetToken = await (await ethers.getContractFactory("AssetToken")).deploy(await registry.getAddress());
  await registry.setAssetTokenContract(await assetToken.getAddress());
  const Token = await ethers.getContractFactory("MockPaymentToken");
  const merkleToken = await Token.deploy("Mock USD", "mUSD", 6);
  const pushToken = await Token.deploy("Mock USD", "mUSD", 6);
  const merkle = await (await ethers.getContractFactory("ProfitDistribution")).deploy(await assetToken.getAddress());
  const snapshot = await (await ethers.getContractFactory("SnapshotProfitDistribution")).deploy(await assetToken.getAddress());
  await assetToken.setAuthorizedCaller(await snapshot.getAddress(), true);

  await registry.registerAsset("Benchmark Asset", "BNCH", "ipfs://benchmark", ethers.keccak256(ethers.toUtf8Bytes("benchmark")), 10000000n, nBig * SHARES_PER_HOLDER);
  await registry.approveAsset(1);
  await assetToken.tokenizeAsset(1, admin.address);

  // N holders, each with gas money and an equal number of shares.
  const holders = [];
  for (let i = 0; i < n; i++) {
    const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
    await ethers.provider.send("hardhat_setBalance", [wallet.address, "0x56BC75E2D63100000"]); // 100 ETH
    await assetToken.safeTransferFrom(admin.address, wallet.address, 1, SHARES_PER_HOLDER, "0x");
    holders.push(wallet);
  }

  const totalPayout = PAYOUT_PER_HOLDER * nBig;

  // --- Merkle ---
  const merkleAddress = await merkle.getAddress();
  const leaves = holders.map((h) => hashLeaf(chainId, merkleAddress, 1n, 1n, h.address, PAYOUT_PER_HOLDER));
  const tree = new MerkleTree(leaves);
  await merkleToken.mint(admin.address, totalPayout);
  const reportHash = ethers.keccak256(ethers.toUtf8Bytes(`benchmark-${n}`));
  const merkleSetup = {
    publishRoot: await gasOf(merkle.createDistributionRound(1n, tree.getRoot(), totalPayout, reportHash, await merkleToken.getAddress())),
    approveToken: await gasOf(merkleToken.approve(merkleAddress, totalPayout)),
    fund: await gasOf(merkle.fundDistributionRound(1n, totalPayout)),
    activate: await gasOf(merkle.activateDistributionRound(1n))
  };
  const merkleClaims = [];
  for (let i = 0; i < n; i++) {
    merkleClaims.push(await gasOf(merkle.connect(holders[i]).claimProfit(1n, PAYOUT_PER_HOLDER, tree.getProof(i))));
  }

  // --- Push: platform transfers to each investor ---
  await pushToken.mint(admin.address, totalPayout);
  const pushTransfers = [];
  for (let i = 0; i < n; i++) {
    pushTransfers.push(await gasOf(pushToken.transfer(holders[i].address, PAYOUT_PER_HOLDER)));
  }

  // --- Snapshot ---
  const snapshotFund = await gasOf(snapshot.fundDistribution(1n, "benchmark", { value: totalPayout }));
  const snapshotClaims = [];
  for (let i = 0; i < n; i++) {
    snapshotClaims.push(await gasOf(snapshot.connect(holders[i]).claimProfit(1n)));
  }

  const merkleSetupGas = sum(Object.values(merkleSetup));
  const merkleClaimGas = sum(merkleClaims);
  const merkleTotal = merkleSetupGas + merkleClaimGas;
  const pushTotal = sum(pushTransfers);
  const snapshotClaimGas = sum(snapshotClaims);
  const snapshotTotal = snapshotFund + snapshotClaimGas;

  return {
    investorCount: n,
    merkleTreeDepth: tree.layers.length - 1,
    proposedFramework: {
      platformSetupGas: Number(merkleSetupGas),
      setupBreakdown: Object.fromEntries(Object.entries(merkleSetup).map(([k, v]) => [k, Number(v)])),
      perInvestorClaimGas: Math.round(Number(merkleClaimGas) / n),
      totalInvestorGas: Number(merkleClaimGas),
      totalNetworkGas: Number(merkleTotal)
    },
    baselinePushFramework: {
      perTransferGas: Math.round(Number(pushTotal) / n),
      totalNetworkGas: Number(pushTotal)
    },
    baselineSnapshotFramework: {
      platformSetupGas: Number(snapshotFund),
      perInvestorClaimGas: Math.round(Number(snapshotClaimGas) / n),
      totalInvestorGas: Number(snapshotClaimGas),
      totalNetworkGas: Number(snapshotTotal)
    },
    comparativeAnalysis: {
      platformGasSavingsVsPushPercent: percentLess(pushTotal, merkleSetupGas),
      totalGasSavingsVsSnapshotPercent: percentLess(snapshotTotal, merkleTotal)
    }
  };
}

async function main() {
  const [admin] = await ethers.getSigners();
  const blockGasLimit = Number((await ethers.provider.getBlock("latest")).gasLimit);

  const scenarios = [];
  for (const n of COHORTS) {
    console.log(`Measuring ${n} investors...`);
    scenarios.push(await measureCohort(n, admin));
  }

  fs.writeFileSync(OUTPUT, JSON.stringify({ generatedAt: new Date().toISOString(), blockGasLimit, scenarios }, null, 2));
  console.log(`Saved ${OUTPUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
