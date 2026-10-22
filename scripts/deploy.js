const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer, user1, user2, user3] = await hre.ethers.getSigners();
  console.log("==================================================");
  console.log("Deploying Full Enhanced RWA Architecture with:", deployer.address);
  console.log("Account balance:", (await hre.ethers.provider.getBalance(deployer.address)).toString());
  console.log("==================================================");

  // 1. Deploy AssetRegistry
  const AssetRegistry = await hre.ethers.getContractFactory("AssetRegistry");
  const registry = await AssetRegistry.deploy();
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log("✔ [1/8] AssetRegistry deployed to:", registryAddress);

  // 2. Deploy AssetToken (ERC-1155)
  const AssetToken = await hre.ethers.getContractFactory("AssetToken");
  const assetToken = await AssetToken.deploy(registryAddress);
  await assetToken.waitForDeployment();
  const tokenAddress = await assetToken.getAddress();
  console.log("✔ [2/8] AssetToken (ERC-1155) deployed to:", tokenAddress);

  // Link AssetToken to AssetRegistry
  const txLink = await registry.setAssetTokenContract(tokenAddress);
  await txLink.wait();
  console.log("✔ AssetRegistry linked to AssetToken");

  // 3. Deploy MockPaymentToken (ERC-20, 6 decimals)
  const MockPaymentToken = await hre.ethers.getContractFactory("MockPaymentToken");
  const paymentToken = await MockPaymentToken.deploy("Mock USD", "mUSD", 6);
  await paymentToken.waitForDeployment();
  const paymentTokenAddress = await paymentToken.getAddress();
  console.log("✔ [3/8] MockPaymentToken (ERC-20) deployed to:", paymentTokenAddress);

  // 4. Deploy AssetMarketplace (Original ETH Marketplace)
  const AssetMarketplace = await hre.ethers.getContractFactory("AssetMarketplace");
  const marketplace = await AssetMarketplace.deploy(tokenAddress);
  await marketplace.waitForDeployment();
  const marketplaceAddress = await marketplace.getAddress();
  console.log("✔ [4/8] AssetMarketplace (ETH) deployed to:", marketplaceAddress);

  // 5. Deploy TokenMarketplace (Non-Custodial ERC-20 Trading Marketplace)
  const feeBps = 100n; // 1% platform fee
  const TokenMarketplace = await hre.ethers.getContractFactory("TokenMarketplace");
  const tokenMarketplace = await TokenMarketplace.deploy(tokenAddress, deployer.address, feeBps);
  await tokenMarketplace.waitForDeployment();
  const tokenMarketplaceAddress = await tokenMarketplace.getAddress();
  console.log("✔ [5/8] TokenMarketplace (Non-Custodial) deployed to:", tokenMarketplaceAddress);

  // 6. Deploy AssetGovernance
  const AssetGovernance = await hre.ethers.getContractFactory("AssetGovernance");
  const governance = await AssetGovernance.deploy(tokenAddress);
  await governance.waitForDeployment();
  const governanceAddress = await governance.getAddress();
  console.log("✔ [6/8] AssetGovernance deployed to:", governanceAddress);

  // 7. Deploy SnapshotProfitDistribution (Baseline Benchmark)
  const SnapshotProfitDistribution = await hre.ethers.getContractFactory("SnapshotProfitDistribution");
  const snapshotDistribution = await SnapshotProfitDistribution.deploy(tokenAddress);
  await snapshotDistribution.waitForDeployment();
  const snapshotDistributionAddress = await snapshotDistribution.getAddress();
  console.log("✔ [7/8] SnapshotProfitDistribution (Baseline) deployed to:", snapshotDistributionAddress);

  // 8. Deploy ProfitDistribution (Proposed Merkle-Based Settlement)
  const ProfitDistribution = await hre.ethers.getContractFactory("ProfitDistribution");
  const distribution = await ProfitDistribution.deploy(tokenAddress);
  await distribution.waitForDeployment();
  const distributionAddress = await distribution.getAddress();
  console.log("✔ [8/8] ProfitDistribution (Merkle Settlement) deployed to:", distributionAddress);

  // 9. Deploy AssetValuationRegistry (versioned, authorized revaluations)
  const AssetValuationRegistry = await hre.ethers.getContractFactory("AssetValuationRegistry");
  const valuationRegistry = await AssetValuationRegistry.deploy(registryAddress, tokenAddress, deployer.address);
  await valuationRegistry.waitForDeployment();
  const valuationRegistryAddress = await valuationRegistry.getAddress();
  // It updates AssetRegistry.valuationLKR when publishing, so it must be an authorized verifier.
  await (await registry.setAuthorizedVerifier(valuationRegistryAddress, true)).wait();
  // Offers that follow the approved price read it from this registry.
  await (await tokenMarketplace.setValuationRegistry(valuationRegistryAddress)).wait();
  console.log("✔ [9/9] AssetValuationRegistry deployed to:", valuationRegistryAddress);

  // 10. Deploy PropertySale (full-property sale: escrow, >50% token vote, Merkle payout)
  const PropertySale = await hre.ethers.getContractFactory("PropertySale");
  const propertySale = await PropertySale.deploy(tokenAddress);
  await propertySale.waitForDeployment();
  const propertySaleAddress = await propertySale.getAddress();
  console.log("✔ [10/10] PropertySale deployed to:", propertySaleAddress);

  // Configure Authorized Callers on AssetToken for snapshots (PropertySale also locks transfers during a sale vote)
  await (await assetToken.setAuthorizedCaller(governanceAddress, true)).wait();
  await (await assetToken.setAuthorizedCaller(snapshotDistributionAddress, true)).wait();
  await (await assetToken.setAuthorizedCaller(propertySaleAddress, true)).wait();
  console.log("✔ Configured Governance, SnapshotDistribution & PropertySale as callers on AssetToken");

  // Fund all signers and test personas with MockPaymentTokens (100,000 mUSD each)
  const allSigners = await hre.ethers.getSigners();
  const faucetAmount = hre.ethers.parseUnits("100000", 6);
  for (const s of allSigners) {
    const bal = await paymentToken.balanceOf(s.address);
    if (bal < faucetAmount) {
      await (await paymentToken.mint(s.address, faucetAmount)).wait();
    }
  }
  // Ensure inv2 is also funded
  const inv2Addr = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";
  if ((await paymentToken.balanceOf(inv2Addr)) < faucetAmount) {
    await (await paymentToken.mint(inv2Addr, faucetAmount)).wait();
  }
  console.log(`✔ Funded all ${allSigners.length} test accounts & demo personas with 100,000 mUSD each`);

  // No demo properties, holdings, listings or proposals are created here. Properties are registered through the app.

  // 11. Export Deployments & ABIs
  const networkName = hre.network.name;
  const deploymentData = {
    network: networkName,
    chainId: hre.network.config.chainId || 31337,
    deployedAt: new Date().toISOString(),
    contracts: {
      AssetRegistry: {
        address: registryAddress,
        abi: JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/AssetRegistry.sol/AssetRegistry.json"))).abi
      },
      AssetToken: {
        address: tokenAddress,
        abi: JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/AssetToken.sol/AssetToken.json"))).abi
      },
      MockPaymentToken: {
        address: paymentTokenAddress,
        abi: JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/MockPaymentToken.sol/MockPaymentToken.json"))).abi
      },
      AssetMarketplace: {
        address: marketplaceAddress,
        abi: JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/AssetMarketplace.sol/AssetMarketplace.json"))).abi
      },
      TokenMarketplace: {
        address: tokenMarketplaceAddress,
        abi: JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/TokenMarketplace.sol/TokenMarketplace.json"))).abi
      },
      AssetGovernance: {
        address: governanceAddress,
        abi: JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/AssetGovernance.sol/AssetGovernance.json"))).abi
      },
      SnapshotProfitDistribution: {
        address: snapshotDistributionAddress,
        abi: JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/SnapshotProfitDistribution.sol/SnapshotProfitDistribution.json"))).abi
      },
      ProfitDistribution: {
        address: distributionAddress,
        abi: JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/ProfitDistribution.sol/ProfitDistribution.json"))).abi
      },
      AssetValuationRegistry: {
        address: valuationRegistryAddress,
        abi: JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/AssetValuationRegistry.sol/AssetValuationRegistry.json"))).abi
      },
      PropertySale: {
        address: propertySaleAddress,
        abi: JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/PropertySale.sol/PropertySale.json"))).abi
      }
    }
  };

  // 12. Sync to shared/, frontend, and backend folders
  const exportDirs = [
    path.join(__dirname, "../deployments"),
    path.join(__dirname, "../../shared/deployments"),
    path.join(__dirname, "../../asset-tokenization-frontend/src/contracts"),
    path.join(__dirname, "../../asset-tokenization-backend/src/contracts")
  ];

  exportDirs.forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(dir, `${networkName === "hardhat" ? "localhost" : networkName}.json`),
      JSON.stringify(deploymentData, null, 2)
    );
    fs.writeFileSync(
      path.join(dir, "deployedContracts.json"),
      JSON.stringify(deploymentData, null, 2)
    );
  });

  // Also save individual ABIs to shared/abi/
  const sharedAbiDir = path.join(__dirname, "../../shared/abi");
  if (!fs.existsSync(sharedAbiDir)) {
    fs.mkdirSync(sharedAbiDir, { recursive: true });
  }
  for (const [name, contract] of Object.entries(deploymentData.contracts)) {
    fs.writeFileSync(
      path.join(sharedAbiDir, `${name}.json`),
      JSON.stringify({ contractName: name, abi: contract.abi }, null, 2)
    );
  }

  console.log("✔ Synced all 8 contract ABIs & deployments to shared/, frontend, and backend!");
  console.log("==================================================");
  console.log("Full RWA Deployment Complete!");
  console.log("==================================================");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
