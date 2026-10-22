/**
 * Sets the resale royalty paid to the original asset owner on the deployed TokenMarketplace.
 * It is a platform decision, 0 until set. 100 basis points = 1%, the contract caps it at 1000 (10%).
 *
 *   ROYALTY_BPS=200 npx hardhat run scripts/setRoyalty.js --network localhost
 */
const hre = require("hardhat");
const deployed = require("../deployments/deployedContracts.json");

async function main() {
  const bps = Number(process.env.ROYALTY_BPS);
  if (!Number.isInteger(bps) || bps < 0) throw new Error("Set ROYALTY_BPS to a whole number, for example ROYALTY_BPS=200 for 2%");
  const config = deployed.contracts.TokenMarketplace;
  const market = await hre.ethers.getContractAt(config.abi, config.address);
  const before = await market.royaltyBps();
  await (await market.setRoyaltyBps(bps)).wait();
  console.log(`Resale royalty changed from ${before} to ${await market.royaltyBps()} basis points`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
