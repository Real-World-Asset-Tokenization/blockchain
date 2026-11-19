// Adds AssetValuationRegistry to an existing deployment without redeploying
// anything else (tokens, balances and listings are untouched).
//
//   npx hardhat run scripts/deploy_valuation_registry.js --network localhost
//
// Re-running is safe: if the recorded address already has code, it only
// re-checks the AssetRegistry authorization.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const targets = [
  path.join(__dirname, "../deployments"),
  path.join(__dirname, "../../shared/deployments"),
  path.join(__dirname, "../../asset-tokenization-frontend/src/contracts"),
  path.join(__dirname, "../../asset-tokenization-backend/src/contracts"),
];

async function main() {
  const source = path.join(__dirname, "../../asset-tokenization-backend/src/contracts/deployedContracts.json");
  const data = JSON.parse(fs.readFileSync(source, "utf8"));
  const [deployer] = await hre.ethers.getSigners();
  const registry = await hre.ethers.getContractAt("AssetRegistry", data.contracts.AssetRegistry.address);
  if ((await registry.owner()).toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error("The first Hardhat account must own AssetRegistry to authorize the valuation registry.");
  }

  let address = data.contracts.AssetValuationRegistry?.address;
  if (!address || (await hre.ethers.provider.getCode(address)) === "0x") {
    const factory = await hre.ethers.getContractFactory("AssetValuationRegistry");
    const vr = await factory.deploy(data.contracts.AssetRegistry.address, data.contracts.AssetToken.address, deployer.address);
    await vr.waitForDeployment();
    address = await vr.getAddress();
    console.log("✔ AssetValuationRegistry deployed to:", address);
  } else {
    console.log("✔ AssetValuationRegistry already deployed at:", address);
  }

  if (!(await registry.authorizedVerifiers(address))) {
    await (await registry.setAuthorizedVerifier(address, true)).wait();
  }
  console.log("✔ Authorized as a valuation verifier on AssetRegistry");

  const abi = JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/AssetValuationRegistry.sol/AssetValuationRegistry.json"))).abi;
  data.contracts.AssetValuationRegistry = { address, abi };
  for (const dir of targets) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    for (const file of ["deployedContracts.json", "localhost.json"]) {
      fs.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2));
    }
  }
  console.log("✔ Address and ABI written to backend, frontend, shared and blockchain/deployments");
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exitCode = 1; });
