/**
 * Replaces only the TokenMarketplace on a running chain, so tokenized properties, balances and
 * valuations stay as they are. The new marketplace can price offers from the published valuation.
 *
 *   npx hardhat run scripts/upgradeMarketplace.js --network localhost
 *
 * Fee, treasury and resale royalty are copied from the old marketplace. LKR_PER_USD (default 310)
 * is the exchange rate used to turn the LKR approved price into mUSD.
 * Open offers on the old marketplace stop working. Sellers list again; their token approval is
 * for the old address, so the next listing asks for one new approval.
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const FILE = path.join(__dirname, "../deployments/deployedContracts.json");

async function main() {
  const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const old = await hre.ethers.getContractAt(data.contracts.TokenMarketplace.abi, data.contracts.TokenMarketplace.address);
  const [treasury, feeBps, royaltyBps] = await Promise.all([old.treasury(), old.feeBps(), old.royaltyBps()]);

  const Market = await hre.ethers.getContractFactory("TokenMarketplace");
  const market = await Market.deploy(data.contracts.AssetToken.address, treasury, feeBps);
  await market.waitForDeployment();
  const address = await market.getAddress();
  await (await market.setValuationRegistry(data.contracts.AssetValuationRegistry.address)).wait();
  const rate = Math.round(Number(process.env.LKR_PER_USD || 310) * 100);
  await (await market.setLkrPerUsd(rate)).wait();
  if (royaltyBps > 0n) await (await market.setRoyaltyBps(royaltyBps)).wait();

  const abi = JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/TokenMarketplace.sol/TokenMarketplace.json"))).abi;
  // Trades made on earlier marketplaces stay readable: the apps read events from every address listed here.
  data.previousTokenMarketplaces = [...(data.previousTokenMarketplaces || []), data.contracts.TokenMarketplace.address];
  data.contracts.TokenMarketplace = { address, abi };
  data.deployedAt = new Date().toISOString();

  const dirs = [
    path.join(__dirname, "../deployments"),
    path.join(__dirname, "../../shared/deployments"),
    path.join(__dirname, "../../asset-tokenization-frontend/src/contracts"),
    path.join(__dirname, "../../asset-tokenization-backend/src/contracts"),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ["deployedContracts.json", `${data.network === "hardhat" ? "localhost" : data.network}.json`]) {
      fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2));
    }
  }
  fs.writeFileSync(path.join(__dirname, "../../shared/abi/TokenMarketplace.json"), JSON.stringify({ contractName: "TokenMarketplace", abi }, null, 2));

  console.log(`TokenMarketplace: ${address}`);
  console.log(`Approved price source: ${data.contracts.AssetValuationRegistry.address}, rate ${rate / 100} LKR per USD`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
