const hre = require("hardhat");

async function main() {
  const deployed = require("../../asset-tokenization-frontend/src/contracts/deployedContracts.json");
  const registryAddress = deployed.contracts.AssetRegistry.address;
  const tokenAddress = deployed.contracts.AssetToken.address;
  
  const [deployer] = await hre.ethers.getSigners();
  console.log("Approving on-chain assets with deployer:", deployer.address);
  
  const registry = await hre.ethers.getContractAt("AssetRegistry", registryAddress, deployer);
  const assetToken = await hre.ethers.getContractAt("AssetToken", tokenAddress, deployer);
  
  const assetIds = await registry.getAllAssetIds();
  for (const id of assetIds) {
    const asset = await registry.getAsset(id);
    const isTokenized = await assetToken.isTokenized(id);
    console.log(`Checking Asset #${id}: ${asset.name}, Status=${asset.status}, isTokenized=${isTokenized}`);
    
    // Status 0 is Pending, Status 1 is Approved
    if (Number(asset.status) === 0) {
      console.log(`Approving Asset #${id} on-chain...`);
      const tx = await registry.approveAsset(id);
      await tx.wait();
      console.log(`✔ Asset #${id} approved!`);
    }
  }
  
  console.log("All on-chain assets verified & approved!");
}

main().catch(console.error);
