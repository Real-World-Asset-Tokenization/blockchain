const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer, user1, user2, user3] = await hre.ethers.getSigners();
  console.log("==================================================");
  console.log("Deploying Full 5-Module RWA Architecture with:", deployer.address);
  console.log("Account balance:", (await hre.ethers.provider.getBalance(deployer.address)).toString());
  console.log("==================================================");

  // 1. Deploy AssetRegistry
  const AssetRegistry = await hre.ethers.getContractFactory("AssetRegistry");
  const registry = await AssetRegistry.deploy();
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log("✔ [1/5] AssetRegistry deployed to:", registryAddress);

  // 2. Deploy AssetToken
  const AssetToken = await hre.ethers.getContractFactory("AssetToken");
  const assetToken = await AssetToken.deploy(registryAddress);
  await assetToken.waitForDeployment();
  const tokenAddress = await assetToken.getAddress();
  console.log("✔ [2/5] AssetToken (ERC-1155) deployed to:", tokenAddress);

  // Link AssetToken to AssetRegistry
  const txLink = await registry.setAssetTokenContract(tokenAddress);
  await txLink.wait();
  console.log("✔ AssetRegistry linked to AssetToken");

  // 3. Deploy AssetMarketplace
  const AssetMarketplace = await hre.ethers.getContractFactory("AssetMarketplace");
  const marketplace = await AssetMarketplace.deploy(tokenAddress);
  await marketplace.waitForDeployment();
  const marketplaceAddress = await marketplace.getAddress();
  console.log("✔ [3/5] AssetMarketplace deployed to:", marketplaceAddress);

  // 4. Deploy AssetGovernance
  const AssetGovernance = await hre.ethers.getContractFactory("AssetGovernance");
  const governance = await AssetGovernance.deploy(tokenAddress);
  await governance.waitForDeployment();
  const governanceAddress = await governance.getAddress();
  console.log("✔ [4/5] AssetGovernance deployed to:", governanceAddress);

  // 5. Deploy ProfitDistribution
  const ProfitDistribution = await hre.ethers.getContractFactory("ProfitDistribution");
  const distribution = await ProfitDistribution.deploy(tokenAddress);
  await distribution.waitForDeployment();
  const distributionAddress = await distribution.getAddress();
  console.log("✔ [5/5] ProfitDistribution deployed to:", distributionAddress);

  // Configure Authorized Callers on AssetToken for snapshots
  await (await assetToken.setAuthorizedCaller(governanceAddress, true)).wait();
  await (await assetToken.setAuthorizedCaller(distributionAddress, true)).wait();
  console.log("✔ Configured Governance and ProfitDistribution as snapshot callers on AssetToken");

  // 6. Seed Real-World Assets & Multi-User Distribution
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

  // Transfer shares to model multi-user test personas (Spec Section 1: A=500, B=300, C=200)
  if (user1 && user2) {
    // Deployer retains 500 shares (Investor A)
    // Transfer 300 shares to user1 (Investor B: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8)
    await (await assetToken.safeTransferFrom(deployer.address, user1.address, 1, 300n, "0x")).wait();
    console.log(`✔ Distributed 300 shares to User 2 (${user1.address})`);

    if (user3) {
      // Transfer 200 shares to user2 (Investor C: 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC)
      await (await assetToken.safeTransferFrom(deployer.address, user2.address, 1, 200n, "0x")).wait();
      console.log(`✔ Distributed 200 shares to User 3 (${user2.address})`);
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

  // Seed Marketplace Listing
  console.log("\n--- Seeding Sample Marketplace Listing & Governance ---");
  await (await assetToken.setApprovalForAll(marketplaceAddress, true)).wait();
  const listTx = await marketplace.listItem(1, 50n, hre.ethers.parseEther("0.02"));
  await listTx.wait();
  console.log("✔ Created Marketplace Listing: 50 shares of Asset #1 @ 0.02 ETH / share");

  // Seed Governance Proposal
  const propTx = await governance.createProposal(
    1,
    "Approve Solar Photovoltaic Grid Installation to Boost Rental NOI by 18%",
    5000
  );
  await propTx.wait();
  console.log("✔ Created Governance Proposal #1 on Asset #1 with snapshot voting");

  // Seed Profit Distribution Period
  const distTx = await distribution.fundDistribution(1, "2026-Q1 Rental Income Waterfall", {
    value: hre.ethers.parseEther("0.5")
  });
  await distTx.wait();
  console.log("✔ Funded Profit Distribution Period #1 with 0.5 ETH yield pool");

  // 7. Export Deployments & ABIs
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
      AssetMarketplace: {
        address: marketplaceAddress,
        abi: JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/AssetMarketplace.sol/AssetMarketplace.json"))).abi
      },
      AssetGovernance: {
        address: governanceAddress,
        abi: JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/AssetGovernance.sol/AssetGovernance.json"))).abi
      },
      ProfitDistribution: {
        address: distributionAddress,
        abi: JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/ProfitDistribution.sol/ProfitDistribution.json"))).abi
      }
    }
  };

  // 8. Sync to shared/, frontend, and backend folders
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

  console.log("✔ Synced all 5 contract ABIs & deployments to shared/, frontend, and backend!");
  console.log("==================================================");
  console.log("Full RWA Deployment Complete!");
  console.log("==================================================");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
