const hre = require("hardhat");

async function main() {
  const deployed = require("../../asset-tokenization-frontend/src/contracts/deployedContracts.json");
  const registryAddress = deployed.contracts.AssetRegistry.address;
  const tokenAddress = deployed.contracts.AssetToken.address;

  const [deployer] = await hre.ethers.getSigners();
  console.log("Using deployer/owner account:", deployer.address);

  const registry = await hre.ethers.getContractAt("AssetRegistry", registryAddress, deployer);
  const assetToken = await hre.ethers.getContractAt("AssetToken", tokenAddress, deployer);

  const existingIds = await registry.getAllAssetIds();
  console.log("Current on-chain asset IDs:", existingIds.map(id => id.toString()));

  if (!existingIds.map(id => id.toString()).includes("4")) {
    console.log("Registering Asset #4 on AssetRegistry.sol...");
    const tx = await registry.registerAsset(
      "Nuwara Eliya High-Grown Tea Estate",
      "NTE-04",
      "ipfs://bafybeihnuwara4teaestate7y26nf3efuylqabf3oclgtqy55fbzdi/tea-estate.json",
      "0x5b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c",
      40000000n,
      4000n
    );
    const receipt = await tx.wait();
    console.log("✔ Asset #4 registered in tx:", receipt.hash);
  } else {
    console.log("Asset #4 already registered in AssetRegistry.");
  }

  // Check status and approve if pending
  const asset4 = await registry.getAsset(4);
  console.log("Asset #4 status on-chain:", asset4.status);
  if (Number(asset4.status) === 0) { // Pending
    console.log("Approving Asset #4 on-chain...");
    const approveTx = await registry.approveAsset(4);
    await approveTx.wait();
    console.log("✔ Asset #4 approved on-chain!");
  } else if (Number(asset4.status) === 1) {
    console.log("Asset #4 is already Approved on-chain.");
  }

  // Verify
  const isTokenized = await assetToken.isTokenized(4);
  const updatedAsset4 = await registry.getAsset(4);
  console.log("Asset #4 Ready for Tokenization:", {
    assetId: updatedAsset4.assetId.toString(),
    name: updatedAsset4.name,
    issuer: updatedAsset4.issuer,
    status: Number(updatedAsset4.status) === 1 ? "Approved" : updatedAsset4.status.toString(),
    totalShares: updatedAsset4.totalShares.toString(),
    isTokenized
  });
}

main().catch(console.error);
