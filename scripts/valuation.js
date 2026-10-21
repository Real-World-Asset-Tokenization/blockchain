// Check an asset's current value and valuation history on the running local chain.
//
//   Show all assets:     npx hardhat run scripts/valuation.js --network localhost
//   Show one + history:  ASSET_ID=1 npx hardhat run scripts/valuation.js --network localhost
//   Value of a wallet:   add WALLET=0x...
//
// Read-only. Values are changed only through the approval workflow
// (POST /api/valuations/proposals -> approve -> publish via AssetValuationRegistry).
//
// (PowerShell: $env:ASSET_ID=1; npx hardhat run ...)
const hre = require("hardhat");
const deployed = require("../../asset-tokenization-frontend/src/contracts/deployedContracts.json");

const STATUS = ["Pending", "Approved", "Tokenized", "Rejected"];
const lkr = (n) => `LKR ${Number(n).toLocaleString()}`;

async function main() {
  const { ethers } = hre;
  const registry = await ethers.getContractAt("AssetRegistry", deployed.contracts.AssetRegistry.address);
  const token = await ethers.getContractAt("AssetToken", deployed.contracts.AssetToken.address);
  const assetId = process.env.ASSET_ID ? BigInt(process.env.ASSET_ID) : null;

  if (assetId == null) {
    const rows = [];
    for (const id of await registry.getAllAssetIds()) {
      const a = await registry.getAsset(id);
      rows.push({
        id: Number(id), name: a.name, status: STATUS[Number(a.status)],
        valuation: lkr(a.valuationLKR), tokens: Number(a.totalShares),
        perToken: lkr(Number(a.valuationLKR) / Number(a.totalShares)),
      });
    }
    console.table(rows);
    return;
  }

  const a = await registry.getAsset(assetId);
  const shares = Number(a.totalShares);
  console.log(`\n#${assetId} ${a.name} [${STATUS[Number(a.status)]}]`);
  console.log(`  Current value : ${lkr(a.valuationLKR)}`);
  console.log(`  Tokens        : ${shares.toLocaleString()} (supply never changes on revaluation)`);
  console.log(`  Price / token : ${lkr(Number(a.valuationLKR) / shares)}`);

  const events = await registry.queryFilter(registry.filters.AssetValuationUpdated(assetId));
  console.log(`\n  Valuation history (${events.length} change${events.length === 1 ? "" : "s"}):`);
  console.log(`    ${new Date(Number(a.createdAt) * 1000).toISOString().slice(0, 10)}  registered`);
  for (const e of events) {
    const { newValuationLKR, oldValuationLKR, timestamp } = e.args;
    console.log(`    ${new Date(Number(timestamp) * 1000).toISOString().slice(0, 10)}  ${lkr(oldValuationLKR)} -> ${lkr(newValuationLKR)}`);
  }

  if (process.env.WALLET) {
    const bal = Number(await token.balanceOf(process.env.WALLET, assetId));
    console.log(`\n  Wallet ${process.env.WALLET}: ${bal} tokens = ${lkr((Number(a.valuationLKR) * bal) / shares)}`);
  }
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exitCode = 1; });
