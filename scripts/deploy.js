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

  // Configure Authorized Callers on AssetToken for snapshots
  await (await assetToken.setAuthorizedCaller(governanceAddress, true)).wait();
  await (await assetToken.setAuthorizedCaller(snapshotDistributionAddress, true)).wait();
  console.log("✔ Configured Governance & SnapshotDistribution as callers on AssetToken");

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

  // 9. Seed Real-World Assets & Multi-User Distribution
  console.log("\n--- Seeding Initial Real-World Assets & Multi-User Holdings ---");

  // Asset 1: Colombo Oceanfront Residence (10M LKR, 1000 shares)
  const tx1 = await registry.registerAsset(
    "Colombo Oceanfront Residence",
    "COR-01",
    "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/colombo-apartment.json",
    "0x9f83c6138438914b1bf0597bc5f8f5339f40feef2c95e5d326f9661d9a5b6d92",
    10000000n,
    1000n
  );
  await tx1.wait();
  await (await registry.approveAsset(1)).wait();
  await (await assetToken.tokenizeAsset(1, deployer.address)).wait();
  console.log("✔ Seeded & Tokenized Asset #1: Colombo Oceanfront Residence (1,000 shares)");

  // Transfer shares to model multi-user test personas (A=500, B=300, C=200)
  if (user1 && user2) {
    // Deployer retains 500 shares (Investor A)
    // Transfer 300 shares to user1 (Investor B)
    await (await assetToken.safeTransferFrom(deployer.address, user1.address, 1, 300n, "0x")).wait();
    console.log(`✔ Distributed 300 shares to User 1 (${user1.address})`);

    if (user3) {
      // Transfer 200 shares to user2 (Investor C)
      await (await assetToken.safeTransferFrom(deployer.address, user2.address, 1, 200n, "0x")).wait();
      console.log(`✔ Distributed 200 shares to User 2 (${user2.address})`);
    }
  }

  // Asset 2: Kandy Commercial Business Park (Pending verification)
  const tx2 = await registry.registerAsset(
    "Kandy Royal Commercial Plaza",
    "KRP-02",
    "ipfs://bafybeihkoviema7g3gx4e2lrtqfop4x42m66x4o2j2v65p3zldu54nhe2y/kandy-plaza.json",
    "0x7c2d5e3f4b6a9c1e2d3b4a5c6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f",
    50000000n,
    5000n
  );
  await tx2.wait();
  console.log("✔ Seeded Asset #2: Kandy Royal Commercial Plaza (5,000 shares, Pending)");

  // Asset 3: Galle Heritage Boutique Villa (Pending verification)
  const tx3 = await registry.registerAsset(
    "Galle Dutch Fort Heritage Villa",
    "GFV-03",
    "ipfs://bafybeicg4f3qpm5u3vx6z7h4h7q2x6o2q4f5o6z7a8b9c0d1e2f3a4b5c6/galle-villa.json",
    "0x4a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b",
    25000000n,
    2500n
  );
  await tx3.wait();
  console.log("✔ Seeded Asset #3: Galle Dutch Fort Heritage Villa (2,500 shares, Pending)");

  // Asset 4: Nuwara Eliya High-Grown Tea Estate (Approved, ready for tokenization)
  const tx4 = await registry.registerAsset(
    "Nuwara Eliya High-Grown Tea Estate",
    "NTE-04",
    "ipfs://bafybeihnuwara4teaestate7y26nf3efuylqabf3oclgtqy55fbzdi/tea-estate.json",
    "0x5b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c",
    40000000n,
    4000n
  );
  await tx4.wait();
  await (await registry.approveAsset(4)).wait();
  console.log("✔ Seeded Asset #4: Nuwara Eliya High-Grown Tea Estate (4,000 shares, Approved)");

  // 10. Seed Sample Marketplace Listings & Governance
  console.log("\n--- Seeding Sample Marketplace Listings & Governance ---");
  // Original ETH marketplace listing
  await (await assetToken.setApprovalForAll(marketplaceAddress, true)).wait();
  const listTx = await marketplace.listItem(1, 50n, hre.ethers.parseEther("0.02"));
  await listTx.wait();
  console.log("✔ Created AssetMarketplace Listing: 50 shares of Asset #1 @ 0.02 ETH / share");

  // Non-Custodial TokenMarketplace listing (50 shares @ 100 mUSD)
  await (await assetToken.setApprovalForAll(tokenMarketplaceAddress, true)).wait();
  const tokenListTx = await tokenMarketplace.createListing(
    1,
    50n,
    hre.ethers.parseUnits("100", 6), // 100 mUSD per token
    paymentTokenAddress,
    86400 * 30 // 30 days
  );
  await tokenListTx.wait();
  console.log("✔ Created TokenMarketplace Listing: 50 shares of Asset #1 @ 100 mUSD / token");

  // Seed Governance Proposal
  const propTx = await governance.createProposal(
    1,
    "Approve Solar Photovoltaic Grid Installation to Boost Rental NOI by 18%",
    5000
  );
  await propTx.wait();
  console.log("✔ Created Governance Proposal #1 on Asset #1 with snapshot voting");

  // Seed Baseline Snapshot Profit Distribution Period
  const distTx = await snapshotDistribution.fundDistribution(1, "2026-Q1 Rental Income Waterfall", {
    value: hre.ethers.parseEther("0.5")
  });
  await distTx.wait();
  console.log("✔ Funded Baseline Snapshot Profit Distribution with 0.5 ETH yield pool");

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
