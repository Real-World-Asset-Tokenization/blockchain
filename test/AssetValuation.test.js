const { expect } = require("chai");
const { ethers } = require("hardhat");

// Asset value rules:
//   price per token = valuationLKR / totalShares
//   holder value    = price per token x tokens held
// A revaluation changes the price only; token supply and balances stay the same.
describe("Asset valuation (current value and revaluation)", function () {
  let registry, assetToken, admin, issuer, investor, verifier, stranger;
  const VALUATION = 10_000_000n; // LKR 10M
  const SHARES = 1000n;           // LKR 10,000 per token

  beforeEach(async function () {
    [admin, issuer, investor, verifier, stranger] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("AssetRegistry")).deploy();
    assetToken = await (await ethers.getContractFactory("AssetToken")).deploy(await registry.getAddress());
    await registry.setAssetTokenContract(await assetToken.getAddress());
    await registry.setAuthorizedVerifier(verifier.address, true);

    await registry.connect(issuer).registerAsset("Kandy Villa", "KV-01", "ipfs://x", "0xabc", VALUATION, SHARES);
    await registry.approveAsset(1);
    await assetToken.tokenizeAsset(1, issuer.address);
    await assetToken.connect(issuer).safeTransferFrom(issuer.address, investor.address, 1, 250n, "0x");
  });

  const holderValue = async (wallet) => {
    const a = await registry.getAsset(1);
    return (a.valuationLKR * (await assetToken.balanceOf(wallet, 1))) / a.totalShares;
  };

  it("TC11: reads the current value and price per token", async function () {
    const a = await registry.getAsset(1);
    expect(a.valuationLKR).to.equal(VALUATION);
    expect(await registry.getInitialReferencePrice(1)).to.equal(10_000n);
    expect(await holderValue(investor.address)).to.equal(2_500_000n); // 250 x 10,000
  });

  it("TC12: revaluation up raises price and holder value, not supply or balances", async function () {
    await expect(registry.connect(verifier).updateAssetValuation(1, 12_000_000n))
      .to.emit(registry, "AssetValuationUpdated");
    const a = await registry.getAsset(1);
    expect(a.valuationLKR).to.equal(12_000_000n);
    expect(a.totalShares).to.equal(SHARES);
    expect(await assetToken.balanceOf(investor.address, 1)).to.equal(250n);
    expect(await registry.getInitialReferencePrice(1)).to.equal(12_000n);
    expect(await holderValue(investor.address)).to.equal(3_000_000n); // +20% profit on paper
  });

  it("TC13: revaluation down lowers holder value (unrealized loss)", async function () {
    await registry.updateAssetValuation(1, 8_000_000n);
    expect(await holderValue(investor.address)).to.equal(2_000_000n); // -20%
  });

  it("TC14: event records old and new value for the history", async function () {
    const tx = await registry.updateAssetValuation(1, 11_000_000n);
    const block = await ethers.provider.getBlock((await tx.wait()).blockNumber);
    await expect(tx).to.emit(registry, "AssetValuationUpdated")
      .withArgs(1n, 11_000_000n, VALUATION, block.timestamp);
  });

  it("TC15: only the admin or an authorized verifier can set the value", async function () {
    await expect(registry.connect(stranger).updateAssetValuation(1, 1n)).to.be.reverted;
    await expect(registry.connect(issuer).updateAssetValuation(1, 99_000_000n)).to.be.reverted; // owners cannot inflate their own asset
  });

  it("TC16: rejects zero, unknown assets and rejected assets", async function () {
    await expect(registry.updateAssetValuation(1, 0n)).to.be.revertedWith("Valuation must be > 0");
    await expect(registry.updateAssetValuation(99, 1n)).to.be.revertedWith("Asset does not exist");
    await registry.connect(issuer).registerAsset("Bad", "B", "ipfs://y", "0xdef", 1n, 1n);
    await registry.rejectAsset(2, "fake deed");
    await expect(registry.updateAssetValuation(2, 5n)).to.be.revertedWith("Asset must be approved or tokenized");
  });
});
