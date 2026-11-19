const hre = require("hardhat");

async function main() {
  const deployed = require("../../asset-tokenization-frontend/src/contracts/deployedContracts.json");
  const registryAddress = deployed.contracts.AssetRegistry.address;
  const tokenAddress = deployed.contracts.AssetToken.address;
  
  console.log("AssetRegistry Address:", registryAddress);
  console.log("AssetToken Address:", tokenAddress);
  
  const registry = await hre.ethers.getContractAt("AssetRegistry", registryAddress);
  const assetToken = await hre.ethers.getContractAt("AssetToken", tokenAddress);
  
  const assetIds = await registry.getAllAssetIds();
  console.log("On-Chain Asset IDs in AssetRegistry:", assetIds.map(id => id.toString()));

  for (const id of assetIds) {
    const asset = await registry.getAsset(id);
    const isTokenized = await assetToken.isTokenized(id);
    const statusMap = ["Pending", "Approved", "Tokenized", "Rejected"];
    console.log(`Asset #${id}:`, {
      name: asset.name,
      symbol: asset.symbol,
      issuer: asset.issuer,
      status: statusMap[Number(asset.status)] || "Unknown",
      totalShares: asset.totalShares.toString(),
      isTokenized: isTokenized
    });
  }
}

main().catch(console.error);
