/**
 * Measures the whole property story once with the baseline approach and once with the optimized approach,
 * for several numbers of investors, and writes it to the backend (src/contracts/gasScenario.json), which
 * serves /api/gas/scenario.
 *
 *   1. Tokenization  the owner registers the land, the platform approves it, the tokens are created
 *   2. Listing       the owner lists 600 of the 1,000 tokens
 *   3. Purchase      investors buy those 600 tokens from the owner
 *   4. Resale        one investor resells half of their tokens to another investor
 *   5. Escrow        a buyer offers to buy the whole property and the price is held
 *   6. Voting        every holder votes, the vote is finalized
 *   7. Escrow        the platform confirms the legal transfer
 *   8. Payout        the sale price is paid to every holder by the tokens they hold
 *
 * Baseline : one mint per token, on-chain listings, approve + buy, individual on-chain votes, the price is
 *            sent to the platform and pushed out with one transfer per holder.
 * Optimized: one mint for the whole supply, signed off-chain orders, permit + buy, signed votes submitted in
 *            one batch, escrow contract, Merkle payout claimed by each holder.
 *
 * Every transaction is real (a Hardhat in-process chain) and is saved with its hash, block, method, gas used and
 * the price paid. Run: npx hardhat run scripts/measureScenarioGas.js
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { hashLeaf, MerkleTree } = require("../test/helpers/merkleHelper");

const COHORTS = [10, 50];
const OUTPUT = path.join(__dirname, "../../asset-tokenization-backend/src/contracts/gasScenario.json");
const ONE = ethers.parseUnits("1", 6);
const TOTAL_TOKENS = 1000n;
const FOR_SALE = 600n;
const TOKEN_PRICE = 100n * ONE;
const SALE_PRICE = 1_000_000n * ONE;
const STAGES = ["Tokenization", "Listing", "Purchase", "Resale", "Voting", "Escrow", "Payout"];
const CATEGORIES = ["Platform", "AssetOwner", "Investor", "Relayer"];

function recorder(flow) {
  const steps = [];
  return {
    steps,
    // Sends one real transaction and keeps its evidence.
    async tx(stage, category, who, contractName, method, label, txPromise) {
      const receipt = await (await txPromise).wait();
      steps.push({
        flow, stage, step: label, contract: contractName, method, payerCategory: category, payerAddress: who.address,
        txHash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: Number(receipt.gasUsed),
        effectiveGasPriceGwei: Number(ethers.formatUnits(receipt.gasPrice, "gwei")), count: 1, offChain: false
      });
      return receipt;
    },
    // A step the user performs by signing only: nothing is sent, so it costs no gas.
    offChain(stage, category, contractName, method, label, count = 1) {
      steps.push({
        flow, stage, step: label, contract: contractName, method, payerCategory: category, payerAddress: null,
        txHash: null, blockNumber: null, gasUsed: 0, effectiveGasPriceGwei: null, count, offChain: true
      });
    },
    // Many identical transactions kept as one row (for example one mint per token); hashes of the first and last are kept.
    async batch(stage, category, who, contractName, method, label, count, makeTx) {
      let gas = 0;
      let first;
      let last;
      let price = 0;
      for (let i = 0; i < count; i++) {
        const r = await (await makeTx(i)).wait();
        gas += Number(r.gasUsed);
        price = Number(ethers.formatUnits(r.gasPrice, "gwei"));
        if (i === 0) first = r;
        last = r;
      }
      steps.push({
        flow, stage, step: label, contract: contractName, method, payerCategory: category, payerAddress: who.address,
        txHash: first.hash, lastTxHash: last.hash, blockNumber: first.blockNumber, lastBlockNumber: last.blockNumber,
        gasUsed: gas, effectiveGasPriceGwei: price, count, offChain: false
      });
    }
  };
}

function summarize(steps) {
  const byStage = STAGES.map((stage) => ({ stage, transactions: 0, totalGas: 0, byCategory: Object.fromEntries(CATEGORIES.map((c) => [c, 0])) }));
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  let transactions = 0;
  let totalGas = 0;
  for (const s of steps) {
    const row = byStage.find((r) => r.stage === s.stage);
    const n = s.offChain ? 0 : s.count;
    row.transactions += n;
    row.totalGas += s.gasUsed;
    row.byCategory[s.payerCategory] += s.gasUsed;
    byCategory[s.payerCategory] += s.gasUsed;
    transactions += n;
    totalGas += s.gasUsed;
  }
  return { transactions, totalGas, byCategory, byStage };
}

async function deployEnvironment() {
  const [platform, owner, buyer, resaleBuyer] = await ethers.getSigners();
  const registry = await (await ethers.getContractFactory("AssetRegistry")).deploy();
  const assetToken = await (await ethers.getContractFactory("AssetToken")).deploy(await registry.getAddress());
  await registry.setAssetTokenContract(await assetToken.getAddress());
  const mUSD = await (await ethers.getContractFactory("MockPaymentToken")).deploy("Mock USD", "mUSD", 6);
  const market = await (await ethers.getContractFactory("TokenMarketplace")).deploy(await assetToken.getAddress(), platform.address, 100);
  const sale = await (await ethers.getContractFactory("PropertySale")).deploy(await assetToken.getAddress());
  const governance = await (await ethers.getContractFactory("AssetGovernance")).deploy(await assetToken.getAddress());
  const baselineMint = await (await ethers.getContractFactory("BaselineMultiMint")).deploy();
  await assetToken.setAuthorizedCaller(await sale.getAddress(), true);
  await assetToken.setAuthorizedCaller(await governance.getAddress(), true);
  const chainId = (await ethers.provider.getNetwork()).chainId;
  return { platform, owner, buyer, resaleBuyer, registry, assetToken, mUSD, market, sale, governance, baselineMint, chainId };
}

async function newInvestors(n, mUSD) {
  const investors = [];
  for (let i = 0; i < n; i++) {
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    await ethers.provider.send("hardhat_setBalance", [w.address, "0x56BC75E2D63100000"]);
    await mUSD.mint(w.address, 1_000_000n * ONE);
    investors.push(w);
  }
  return investors;
}

// Payout per holder: price x balance / supply, the rounding remainder goes to the largest holder.
function payoutsFor(holders) {
  const payouts = holders.map((h) => (SALE_PRICE * h.balance) / TOTAL_TOKENS);
  const largest = holders.reduce((best, h, i) => (h.balance > holders[best].balance ? i : best), 0);
  payouts[largest] += SALE_PRICE - payouts.reduce((a, b) => a + b, 0n);
  return payouts;
}

async function runOptimized(n) {
  const env = await deployEnvironment();
  const { platform, owner, buyer, resaleBuyer, registry, assetToken, mUSD, market, sale, chainId } = env;
  const rec = recorder("optimized");
  const investors = await newInvestors(n, mUSD);
  await mUSD.mint(buyer.address, SALE_PRICE);
  await mUSD.mint(resaleBuyer.address, 1_000_000n * ONE);
  const each = FOR_SALE / BigInt(n);
  const marketAddress = await market.getAddress();

  // 1. Tokenization: the whole supply is created in one transaction
  await rec.tx("Tokenization", "AssetOwner", owner, "AssetRegistry", "registerAsset", "Owner registers the land",
    registry.connect(owner).registerAsset("Colombo Land", "CLD", "ipfs://colombo", ethers.keccak256(ethers.toUtf8Bytes("deed")), 10000000n, TOTAL_TOKENS));
  await rec.tx("Tokenization", "Platform", platform, "AssetRegistry", "approveAsset", "Platform approves the land", registry.approveAsset(1));
  await rec.tx("Tokenization", "AssetOwner", owner, "AssetToken", "tokenize", "Owner creates all 1,000 tokens in one transaction", assetToken.connect(owner).tokenize(1));

  // 2. Listing: one signed order, no listing transaction
  await rec.tx("Listing", "AssetOwner", owner, "AssetToken", "setApprovalForAll", "Owner allows the marketplace to move the tokens",
    assetToken.connect(owner).setApprovalForAll(marketAddress, true));
  const orderDomain = { name: "TokenMarketplace", version: "1", chainId, verifyingContract: marketAddress };
  const orderTypes = { Order: [
    { name: "seller", type: "address" }, { name: "assetId", type: "uint256" }, { name: "amount", type: "uint256" },
    { name: "pricePerToken", type: "uint256" }, { name: "paymentToken", type: "address" }, { name: "expiry", type: "uint256" }, { name: "salt", type: "uint256" }] };
  const paymentToken = await mUSD.getAddress();
  const ownerOrder = { seller: owner.address, assetId: 1n, amount: FOR_SALE, pricePerToken: TOKEN_PRICE, paymentToken, expiry: 0n, salt: 1n };
  const ownerSig = await owner.signTypedData(orderDomain, orderTypes, ownerOrder);
  rec.offChain("Listing", "AssetOwner", "TokenMarketplace", "(EIP-712 signature)", "Owner signs one sell order for 600 tokens", 1);

  // 3. Purchase: each investor buys with a permit signed off-chain (one transaction each)
  const permitTypes = { Permit: [
    { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] };
  const permitFor = async (signer, value) => {
    const deadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600);
    const domain = { name: "Mock USD", version: "1", chainId, verifyingContract: paymentToken };
    const sig = ethers.Signature.from(await signer.signTypedData(domain, permitTypes, {
      owner: signer.address, spender: marketAddress, value, nonce: await mUSD.nonces(signer.address), deadline }));
    return { deadline, sig };
  };
  rec.offChain("Purchase", "Investor", "MockPaymentToken", "(ERC-2612 permit signature)", `${n} investors sign a payment permit`, n);
  for (let i = 0; i < n; i++) {
    const { deadline, sig } = await permitFor(investors[i], each * TOKEN_PRICE);
    await rec.tx("Purchase", "Investor", investors[i], "TokenMarketplace", "fillSignedOrderWithPermit", `Investor ${i + 1} buys ${each} tokens`,
      market.connect(investors[i]).fillSignedOrderWithPermit(ownerOrder, ownerSig, each, deadline, sig.v, sig.r, sig.s));
  }

  // 4. Resale: investor 1 resells half of their tokens to a new investor
  const resaleAmount = each / 2n;
  await rec.tx("Listing", "Investor", investors[0], "AssetToken", "setApprovalForAll", "Investor 1 allows the marketplace to move their tokens",
    assetToken.connect(investors[0]).setApprovalForAll(marketAddress, true));
  const resaleOrder = { seller: investors[0].address, assetId: 1n, amount: resaleAmount, pricePerToken: 120n * ONE, paymentToken, expiry: 0n, salt: 2n };
  const resaleSig = await investors[0].signTypedData(orderDomain, orderTypes, resaleOrder);
  rec.offChain("Listing", "Investor", "TokenMarketplace", "(EIP-712 signature)", "Investor 1 signs a resale order", 1);
  const resalePermit = await permitFor(resaleBuyer, resaleAmount * 120n * ONE);
  await rec.tx("Resale", "Investor", resaleBuyer, "TokenMarketplace", "fillSignedOrderWithPermit", `A new investor buys ${resaleAmount} tokens from Investor 1`,
    market.connect(resaleBuyer).fillSignedOrderWithPermit(resaleOrder, resaleSig, resaleAmount, resalePermit.deadline, resalePermit.sig.v, resalePermit.sig.r, resalePermit.sig.s));

  // 5. Escrow: the buyer offers for the whole property
  const saleAddress = await sale.getAddress();
  await rec.tx("Escrow", "Investor", buyer, "MockPaymentToken", "approve", "Buyer allows the sale contract to hold the price", mUSD.connect(buyer).approve(saleAddress, SALE_PRICE));
  await rec.tx("Escrow", "Investor", buyer, "PropertySale", "createOffer", "Buyer offers for the whole property and the price is held", sale.connect(buyer).createOffer(1, paymentToken, SALE_PRICE, 7 * 86400));

  // 6. Voting: transfers freeze, everyone signs, the platform submits all votes together
  await rec.tx("Voting", "Platform", platform, "PropertySale", "openVoting", "Platform opens voting", sale.openVoting(1));
  const voteDomain = { name: "PropertySale", version: "1", chainId, verifyingContract: saleAddress };
  const voteTypes = { Vote: [{ name: "offerId", type: "uint256" }, { name: "support", type: "uint8" }] };
  const voters = [owner, ...investors, resaleBuyer];
  const signatures = [];
  for (const v of voters) signatures.push(await v.signTypedData(voteDomain, voteTypes, { offerId: 1, support: 1 }));
  rec.offChain("Voting", "Investor", "PropertySale", "(EIP-712 signature)", `${voters.length} holders sign a yes vote`, voters.length);
  await rec.tx("Voting", "Relayer", platform, "PropertySale", "castVotesBySig", `One transaction submits ${voters.length} signed votes`,
    sale.castVotesBySig(1, voters.map(() => 1), signatures));
  await rec.tx("Voting", "Platform", platform, "PropertySale", "finalize", "Platform finalizes the vote", sale.finalize(1));

  // 7. Escrow: legal transfer confirmed, payouts published
  const holderList = [];
  for (const w of voters) {
    const balance = await assetToken.balanceOfAtSnapshot(w.address, 1, 1);
    if (balance > 0n) holderList.push({ wallet: w, balance });
  }
  const payouts = payoutsFor(holderList);
  const tree = new MerkleTree(holderList.map((h, i) => hashLeaf(chainId, saleAddress, 1n, 1n, h.wallet.address, payouts[i])));
  await rec.tx("Escrow", "Platform", platform, "PropertySale", "confirmSale", "Platform confirms the legal transfer and publishes the payouts", sale.confirmSale(1, tree.getRoot()));

  // 8. Payout: every holder claims their share
  for (let i = 0; i < holderList.length; i++) {
    const w = holderList[i].wallet;
    const isOwner = w.address === owner.address;
    await rec.tx("Payout", isOwner ? "AssetOwner" : "Investor", w, "PropertySale", "claim", isOwner ? "Owner claims their share" : `Holder ${i} claims their share`,
      sale.connect(w).claim(1, payouts[i], tree.getProof(i)));
  }
  return { steps: rec.steps, ...summarize(rec.steps) };
}

async function runBaseline(n) {
  const env = await deployEnvironment();
  const { platform, owner, buyer, resaleBuyer, registry, assetToken, mUSD, market, governance, baselineMint } = env;
  const rec = recorder("baseline");
  const investors = await newInvestors(n, mUSD);
  await mUSD.mint(buyer.address, SALE_PRICE);
  await mUSD.mint(resaleBuyer.address, 1_000_000n * ONE);
  const each = FOR_SALE / BigInt(n);
  const marketAddress = await market.getAddress();
  const paymentToken = await mUSD.getAddress();

  // 1. Tokenization: one mint transaction per token
  await rec.tx("Tokenization", "AssetOwner", owner, "AssetRegistry", "registerAsset", "Owner registers the land",
    registry.connect(owner).registerAsset("Colombo Land", "CLD", "ipfs://colombo", ethers.keccak256(ethers.toUtf8Bytes("deed")), 10000000n, TOTAL_TOKENS));
  await rec.tx("Tokenization", "Platform", platform, "AssetRegistry", "approveAsset", "Platform approves the land", registry.approveAsset(1));
  await rec.batch("Tokenization", "AssetOwner", owner, "BaselineMultiMint", "mintOne", "Owner creates the 1,000 tokens one transaction at a time", Number(TOTAL_TOKENS),
    () => baselineMint.connect(owner).mintOne(owner.address, 1));
  // The rest of the story runs on the platform's token, so create it too (not counted: the mints above stand in for it).
  await assetToken.connect(owner).tokenize(1);

  // 2. Listing: an on-chain listing transaction
  await rec.tx("Listing", "AssetOwner", owner, "AssetToken", "setApprovalForAll", "Owner allows the marketplace to move the tokens",
    assetToken.connect(owner).setApprovalForAll(marketAddress, true));
  await rec.tx("Listing", "AssetOwner", owner, "TokenMarketplace", "createListing", "Owner publishes a listing for 600 tokens",
    market.connect(owner).createListing(1, FOR_SALE, TOKEN_PRICE, paymentToken, 0));

  // 3. Purchase: approve, then buy
  for (let i = 0; i < n; i++) {
    await rec.tx("Purchase", "Investor", investors[i], "MockPaymentToken", "approve", `Investor ${i + 1} approves the payment`,
      mUSD.connect(investors[i]).approve(marketAddress, each * TOKEN_PRICE));
    await rec.tx("Purchase", "Investor", investors[i], "TokenMarketplace", "buyListingAmount", `Investor ${i + 1} buys ${each} tokens`,
      market.connect(investors[i]).buyListingAmount(1, each));
  }

  // 4. Resale: on-chain listing, approve, buy
  const resaleAmount = each / 2n;
  await rec.tx("Listing", "Investor", investors[0], "AssetToken", "setApprovalForAll", "Investor 1 allows the marketplace to move their tokens",
    assetToken.connect(investors[0]).setApprovalForAll(marketAddress, true));
  await rec.tx("Listing", "Investor", investors[0], "TokenMarketplace", "createListing", "Investor 1 publishes a resale listing",
    market.connect(investors[0]).createListing(1, resaleAmount, 120n * ONE, paymentToken, 0));
  await rec.tx("Purchase", "Investor", resaleBuyer, "MockPaymentToken", "approve", "A new investor approves the payment",
    mUSD.connect(resaleBuyer).approve(marketAddress, resaleAmount * 120n * ONE));
  await rec.tx("Resale", "Investor", resaleBuyer, "TokenMarketplace", "buyListing", `A new investor buys ${resaleAmount} tokens from Investor 1`,
    market.connect(resaleBuyer).buyListing(2));

  // 5. Escrow: no escrow contract, the buyer sends the price to the platform
  await rec.tx("Escrow", "Investor", buyer, "MockPaymentToken", "transfer", "Buyer sends the price to the platform", mUSD.connect(buyer).transfer(platform.address, SALE_PRICE));

  // 6. Voting: every holder votes on-chain
  const voters = [owner, ...investors, resaleBuyer];
  await rec.tx("Voting", "AssetOwner", owner, "AssetGovernance", "createProposal", "Owner creates the sale proposal (snapshot)",
    governance.connect(owner).createProposal(1, "Sell the property", 100000));
  for (let i = 0; i < voters.length; i++) {
    const isOwner = voters[i].address === owner.address;
    await rec.tx("Voting", isOwner ? "AssetOwner" : "Investor", voters[i], "AssetGovernance", "castVote", isOwner ? "Owner votes" : `Holder ${i} votes`,
      governance.connect(voters[i]).castVote(1, 1));
  }
  await rec.tx("Voting", "Platform", platform, "AssetGovernance", "finalizeProposal", "Platform finalizes the vote", governance.finalizeProposal(1));

  // 7./8. Payout: the platform pushes one transfer to every holder
  const holderList = [];
  for (const w of voters) {
    const balance = await assetToken.balanceOf(w.address, 1);
    if (balance > 0n) holderList.push({ wallet: w, balance });
  }
  const payouts = payoutsFor(holderList);
  for (let i = 0; i < holderList.length; i++) {
    await rec.tx("Payout", "Platform", platform, "MockPaymentToken", "transfer", `Platform pays holder ${i}`, mUSD.transfer(holderList[i].wallet.address, payouts[i]));
  }
  return { steps: rec.steps, ...summarize(rec.steps) };
}

const saved = (baseline, value) => (baseline > 0 ? Math.round(((baseline - value) / baseline) * 10000) / 100 : 0);

async function main() {
  const cohorts = [];
  for (const n of COHORTS) {
    console.log(`Scenario with ${n} investors: baseline...`);
    const baseline = await runBaseline(n);
    console.log(`Scenario with ${n} investors: optimized...`);
    const optimized = await runOptimized(n);

    cohorts.push({
      investors: n,
      holders: n + 2,
      flows: { baseline, optimized },
      comparison: {
        totalGasSavedPercent: saved(baseline.totalGas, optimized.totalGas),
        transactionsBaseline: baseline.transactions,
        transactionsOptimized: optimized.transactions,
        byStage: STAGES.map((stage, i) => ({
          stage,
          baselineGas: baseline.byStage[i].totalGas,
          optimizedGas: optimized.byStage[i].totalGas,
          savedPercent: saved(baseline.byStage[i].totalGas, optimized.byStage[i].totalGas)
        }))
      }
    });
  }

  const network = (await ethers.provider.getNetwork());
  fs.writeFileSync(OUTPUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    network: { name: "Hardhat in-process network", chainId: Number(network.chainId), note: "Transactions were sent to a temporary test chain, so the hashes exist only inside this benchmark run." },
    cohorts
  }, null, 2));
  console.log(`Saved ${OUTPUT}`);
  for (const c of cohorts) {
    console.log(`${c.investors} investors: baseline ${c.flows.baseline.totalGas.toLocaleString()} gas (${c.flows.baseline.transactions} tx), optimized ${c.flows.optimized.totalGas.toLocaleString()} gas (${c.flows.optimized.transactions} tx), saved ${c.comparison.totalGasSavedPercent}%`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
