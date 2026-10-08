const hre = require("hardhat");

async function main() {
  const recipient = process.env.TARGET || process.env.TARGET_ADDRESS;

  if (!recipient || !hre.ethers.isAddress(recipient)) {
    console.log("==================================================");
    console.log("Please specify the recipient address with $env:TARGET");
    console.log("Example in PowerShell:");
    console.log('  $env:TARGET = "0xYourWalletAddress"');
    console.log("  npx hardhat run scripts/fund.js --network localhost");
    console.log("==================================================");
    return;
  }

  const [deployer] = await hre.ethers.getSigners();
  console.log("==================================================");
  console.log("Funding wallet from deployer:", deployer.address);
  console.log("Target wallet:", recipient);

  // 1. Send 1,000 ETH
  const tx = await deployer.sendTransaction({
    to: recipient,
    value: hre.ethers.parseEther("1000.0"),
  });
  await tx.wait();
  console.log("✔ Sent 1,000 ETH! Transaction hash:", tx.hash);

  // 2. Transfer 200 fractional tokens of Asset #1 (Colombo Oceanfront Residence)
  const deployed = require("../deployments/localhost.json");
  const tokenContract = await hre.ethers.getContractAt(
    "AssetToken",
    deployed.contracts.AssetToken.address,
    deployer
  );

  const balance = await tokenContract.balanceOf(deployer.address, 1);
  if (balance >= 200n && recipient.toLowerCase() !== deployer.address.toLowerCase()) {
    const txToken = await tokenContract.safeTransferFrom(
      deployer.address,
      recipient,
      1,
      200n,
      "0x"
    );
    await txToken.wait();
    console.log("✔ Sent 200 Colombo fractional shares! Tx hash:", txToken.hash);
  }

  const finalEthBal = await hre.ethers.provider.getBalance(recipient);
  const finalTokenBal = await tokenContract.balanceOf(recipient, 1);
  console.log("==================================================");
  console.log("New Wallet Balance:", hre.ethers.formatEther(finalEthBal), "ETH");
  console.log("New Property Token Balance:", finalTokenBal.toString(), "Shares");
  console.log("==================================================");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
