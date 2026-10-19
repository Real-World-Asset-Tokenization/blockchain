const hre = require("hardhat");

async function main() {
  const signers = await hre.ethers.getSigners();
  const paymentTokenAddress = "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9";
  const abi = [
    "function mint(address, uint256) external",
    "function balanceOf(address) view returns (uint256)"
  ];
  const paymentToken = await hre.ethers.getContractAt("MockPaymentToken", paymentTokenAddress);
  const faucetAmount = hre.ethers.parseUnits("100000", 6);

  console.log("Funding all test accounts with 100,000 mUSD...");

  for (let i = 0; i < signers.length; i++) {
    const signer = signers[i];
    const bal = await paymentToken.balanceOf(signer.address);
    if (bal < faucetAmount) {
      const tx = await paymentToken.mint(signer.address, faucetAmount);
      await tx.wait();
      console.log(`[Signer ${i}] Minted 100,000 mUSD to: ${signer.address}`);
    } else {
      console.log(`[Signer ${i}] Already funded: ${signer.address} (${hre.ethers.formatUnits(bal, 6)} mUSD)`);
    }
  }

  // Also fund inv2 address explicitly if not covered
  const inv2Addr = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";
  const inv2Bal = await paymentToken.balanceOf(inv2Addr);
  if (inv2Bal < faucetAmount) {
    const tx = await paymentToken.mint(inv2Addr, faucetAmount);
    await tx.wait();
    console.log(`Minted 100,000 mUSD to inv2: ${inv2Addr}`);
  } else {
    console.log(`inv2 already funded: ${inv2Addr} (${hre.ethers.formatUnits(inv2Bal, 6)} mUSD)`);
  }

  console.log("✔ All accounts successfully funded with 100,000 mUSD on localhost!");
}

main().catch((err) => {
  console.error("Funding error:", err);
  process.exit(1);
});
