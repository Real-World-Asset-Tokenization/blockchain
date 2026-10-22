/**
 * Measures the gas saved by the marketplace and governance optimizations and writes the result to
 * the backend (src/contracts/gasOptimizations.json), which serves /api/gas/optimizations.
 *
 *   Listing : on-chain createListing + buyListing   vs   off-chain signed order + fillSignedOrder
 *   Voting  : one castVote transaction per holder   vs   one castVotesBySig batch for all holders
 *   Approval: approve transaction + fillSignedOrder  vs   one fillSignedOrderWithPermit transaction
 *   Minting : one transaction per token             vs   the whole supply in one transaction
 *
 * Run: npx hardhat run scripts/measureOptimizationGas.js
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const VOTER_COUNTS = [10, 50, 100];
const OUTPUT = path.join(__dirname, "../../asset-tokenization-backend/src/contracts/gasOptimizations.json");
const ONE = ethers.parseUnits("1", 6);

const gasOf = async (txPromise) => Number((await (await txPromise).wait()).gasUsed);
const percentLess = (base, value) => Math.round(((base - value) / base) * 10000) / 100;

async function deployBase(supply) {
  const [admin, owner] = await ethers.getSigners();
  const registry = await (await ethers.getContractFactory("AssetRegistry")).deploy();
  const assetToken = await (await ethers.getContractFactory("AssetToken")).deploy(await registry.getAddress());
  await registry.setAssetTokenContract(await assetToken.getAddress());
  const mUSD = await (await ethers.getContractFactory("MockPaymentToken")).deploy("Mock USD", "mUSD", 6);
  const market = await (await ethers.getContractFactory("TokenMarketplace")).deploy(await assetToken.getAddress(), admin.address, 100);
  const sale = await (await ethers.getContractFactory("PropertySale")).deploy(await assetToken.getAddress());
  await assetToken.setAuthorizedCaller(await sale.getAddress(), true);
  await registry.connect(owner).registerAsset("Benchmark Asset", "BNCH", "ipfs://benchmark", ethers.keccak256(ethers.toUtf8Bytes("deed")), 10000000n, BigInt(supply));
  await registry.approveAsset(1);
  await assetToken.connect(owner).tokenize(1);
  return { admin, owner, assetToken, mUSD, market, sale };
}

async function measureListing() {
  const { admin: treasury, owner, assetToken, mUSD, market } = await deployBase(1000);
  const [, , buyer1, buyer2] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const price = 100n * ONE;
  for (const b of [buyer1, buyer2]) {
    await mUSD.mint(b.address, 1_000_000n * ONE);
    await mUSD.connect(b).approve(await market.getAddress(), ethers.MaxUint256);
  }
  await assetToken.connect(owner).setApprovalForAll(await market.getAddress(), true);

  // The first payment into an empty balance costs extra storage gas. Give the seller and the
  // treasury a balance first so both methods are measured under the same conditions.
  await mUSD.mint(owner.address, ONE);
  await mUSD.mint(treasury.address, ONE);

  // On-chain listing, then purchase
  const createListingGas = await gasOf(market.connect(owner).createListing(1, 100n, price, await mUSD.getAddress(), 86400));
  const buyListingGas = await gasOf(market.connect(buyer1).buyListing(1));

  // Signed order: the seller only signs, the buyer's transaction settles
  const order = {
    seller: owner.address, assetId: 1n, amount: 100n, pricePerToken: price,
    paymentToken: await mUSD.getAddress(), expiry: 0n, salt: 1n
  };
  const domain = { name: "TokenMarketplace", version: "1", chainId, verifyingContract: await market.getAddress() };
  const types = {
    Order: [
      { name: "seller", type: "address" }, { name: "assetId", type: "uint256" }, { name: "amount", type: "uint256" },
      { name: "pricePerToken", type: "uint256" }, { name: "paymentToken", type: "address" },
      { name: "expiry", type: "uint256" }, { name: "salt", type: "uint256" }
    ]
  };
  const signature = await owner.signTypedData(domain, types, order);
  const signedFillGas = await gasOf(market.connect(buyer2).fillSignedOrder(order, signature, 100n));

  // Approval: a separate approve transaction before the purchase, or an off-chain permit inside it
  const [, , , , buyer3, buyer4] = await ethers.getSigners();
  const cost = 100n * price;
  const orderFor = async (salt) => {
    const o = { ...order, salt: BigInt(salt) };
    return { o, sig: await owner.signTypedData(domain, types, o) };
  };
  await mUSD.mint(buyer3.address, 1_000_000n * ONE);
  await mUSD.mint(buyer4.address, 1_000_000n * ONE);
  const separate = await orderFor(2);
  const approveGas = await gasOf(mUSD.connect(buyer3).approve(await market.getAddress(), cost));
  const fillAfterApproveGas = await gasOf(market.connect(buyer3).fillSignedOrder(separate.o, separate.sig, 100n));

  const withPermit = await orderFor(3);
  const deadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600);
  const permitDomain = { name: "Mock USD", version: "1", chainId, verifyingContract: await mUSD.getAddress() };
  const permitTypes = {
    Permit: [
      { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }
    ]
  };
  const permitSig = ethers.Signature.from(await buyer4.signTypedData(permitDomain, permitTypes, {
    owner: buyer4.address, spender: await market.getAddress(), value: cost, nonce: await mUSD.nonces(buyer4.address), deadline
  }));
  const permitFillGas = await gasOf(
    market.connect(buyer4).fillSignedOrderWithPermit(withPermit.o, withPermit.sig, 100n, deadline, permitSig.v, permitSig.r, permitSig.s)
  );

  return {
    approval: {
      separateApproveGas: approveGas,
      fillAfterApproveGas,
      separateTotalGas: approveGas + fillAfterApproveGas,
      permitFillGas,
      transactionsSaved: 1,
      totalGasSavedPercent: percentLess(approveGas + fillAfterApproveGas, permitFillGas)
    },
    onChain: { sellerListingGas: createListingGas, buyerPurchaseGas: buyListingGas, totalGas: createListingGas + buyListingGas },
    signedOrder: { sellerListingGas: 0, buyerPurchaseGas: signedFillGas, totalGas: signedFillGas },
    sellerGasSavedPercent: 100,
    totalGasSavedPercent: percentLess(createListingGas + buyListingGas, signedFillGas),
    buyerExtraGas: signedFillGas - buyListingGas
  };
}

async function setupVoting(n) {
  const base = await deployBase(n * 10);
  const { owner, assetToken, mUSD, sale, admin } = base;
  const holders = [];
  for (let i = 0; i < n; i++) {
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    await ethers.provider.send("hardhat_setBalance", [w.address, "0x56BC75E2D63100000"]);
    await assetToken.connect(owner).safeTransferFrom(owner.address, w.address, 1, 10n, "0x");
    holders.push(w);
  }
  // The owner keeps no tokens: all supply is held by the n voters.
  const buyer = (await ethers.getSigners())[5];
  const price = 1000n * ONE;
  await mUSD.mint(buyer.address, price);
  await mUSD.connect(buyer).approve(await sale.getAddress(), price);
  await sale.connect(buyer).createOffer(1, await mUSD.getAddress(), price, 7 * 24 * 3600);
  await sale.connect(admin).openVoting(1);
  return { sale, holders, chainId: (await ethers.provider.getNetwork()).chainId };
}

async function measureVoting(n) {
  // Individual: every holder sends their own transaction
  const a = await setupVoting(n);
  let individualTotal = 0;
  for (const h of a.holders) individualTotal += await gasOf(a.sale.connect(h).castVote(1, 1));

  // Batch: holders sign off-chain, one relayer submits everything
  const b = await setupVoting(n);
  const domain = { name: "PropertySale", version: "1", chainId: b.chainId, verifyingContract: await b.sale.getAddress() };
  const types = { Vote: [{ name: "offerId", type: "uint256" }, { name: "support", type: "uint8" }] };
  const signatures = [];
  for (const h of b.holders) signatures.push(await h.signTypedData(domain, types, { offerId: 1, support: 1 }));
  const relayer = (await ethers.getSigners())[6];
  const batchGas = await gasOf(b.sale.connect(relayer).castVotesBySig(1, b.holders.map(() => 1), signatures));
  const offer = await b.sale.getOffer(1);
  if (offer.yesVotes !== BigInt(n * 10)) throw new Error(`Batch counted ${offer.yesVotes} of ${n * 10} votes`);

  return {
    voters: n,
    individualTotalGas: individualTotal,
    individualPerVoteGas: Math.round(individualTotal / n),
    batchTotalGas: batchGas,
    batchPerVoteGas: Math.round(batchGas / n),
    totalGasSavedPercent: percentLess(individualTotal, batchGas),
    // Holders pay nothing in the batch; the relayer (platform or any account) pays the one transaction.
    holderGasAfterBatch: 0
  };
}

async function measureMinting(n) {
  const [, owner] = await ethers.getSigners();
  const baseline = await (await ethers.getContractFactory("BaselineMultiMint")).deploy();
  let perTokenTotal = 0;
  for (let i = 0; i < n; i++) perTokenTotal += await gasOf(baseline.mintOne(owner.address, 1));
  const oneTransaction = await gasOf(baseline.mintAll(owner.address, 2, n));

  // The platform's real tokenization (it also does registry bookkeeping), for reference.
  const registry = await (await ethers.getContractFactory("AssetRegistry")).deploy();
  const assetToken = await (await ethers.getContractFactory("AssetToken")).deploy(await registry.getAddress());
  await registry.setAssetTokenContract(await assetToken.getAddress());
  await registry.connect(owner).registerAsset("Mint Asset", "MINT", "ipfs://mint", ethers.keccak256(ethers.toUtf8Bytes("deed")), 10000000n, BigInt(n));
  await registry.approveAsset(1);
  const tokenizeGas = await gasOf(assetToken.connect(owner).tokenize(1));

  return {
    tokens: n,
    transactionsBaseline: n,
    transactionsOptimized: 1,
    perTokenMintsTotalGas: perTokenTotal,
    singleMintGas: oneTransaction,
    totalGasSavedPercent: percentLess(perTokenTotal, oneTransaction),
    platformTokenizeGas: tokenizeGas
  };
}

async function main() {
  console.log("Measuring listing...");
  const listing = await measureListing();
  const minting = [];
  for (const n of [10, 100, 1000]) {
    console.log("Measuring minting of " + n + " tokens...");
    minting.push(await measureMinting(n));
  }
  const voting = [];
  for (const n of VOTER_COUNTS) {
    console.log(`Measuring ${n} voters...`);
    voting.push(await measureVoting(n));
  }
  fs.writeFileSync(OUTPUT, JSON.stringify({ generatedAt: new Date().toISOString(), listing, voting, minting }, null, 2));
  console.log(`Saved ${OUTPUT}`);
  console.log(JSON.stringify({ listing, voting, minting }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
