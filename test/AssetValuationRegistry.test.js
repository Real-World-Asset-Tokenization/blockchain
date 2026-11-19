const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AssetValuationRegistry (versioned, authorized revaluation)", function () {
  let registry, token, vr, admin, publisher, owner, investor, stranger;
  const LKR = ethers.encodeBytes32String("LKR");
  const H = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
  const now = async () => (await ethers.provider.getBlock("latest")).timestamp;
  const publish = async (signer, version, value, opts = {}) =>
    vr.connect(signer).publishValuation(
      opts.assetId ?? 1, version, value, opts.currency ?? LKR,
      opts.date ?? (await now()) - 60, opts.report ?? H(`report-${version}`), opts.ref ?? H(`proposal-${version}`)
    );

  beforeEach(async function () {
    [admin, publisher, owner, investor, stranger] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("AssetRegistry")).deploy();
    token = await (await ethers.getContractFactory("AssetToken")).deploy(await registry.getAddress());
    await registry.setAssetTokenContract(await token.getAddress());
    vr = await (await ethers.getContractFactory("AssetValuationRegistry"))
      .deploy(await registry.getAddress(), await token.getAddress(), admin.address);
    await registry.setAuthorizedVerifier(await vr.getAddress(), true);
    await vr.grantRole(await vr.VALUATION_PUBLISHER_ROLE(), publisher.address);

    await registry.connect(owner).registerAsset("Colombo Oceanfront Residence", "COR-01", "ipfs://x", "0xdoc", 10_000_000n, 1000n);
    await registry.approveAsset(1);
    await token.tokenizeAsset(1, owner.address);
    await token.connect(owner).safeTransferFrom(owner.address, investor.address, 1, 300n, "0x");
  });

  it("VR01: publishes 10M -> 12M; reference price 10,000 -> 12,000; supply and balances unchanged", async function () {
    expect(await vr.getReferencePriceCents(1)).to.equal(1_000_000n);
    await expect(publish(publisher, 1, 12_000_000n)).to.emit(vr, "ValuationPublished");
    expect((await registry.getAsset(1)).valuationLKR).to.equal(12_000_000n); // registry kept in step
    expect(await vr.getReferencePriceCents(1)).to.equal(1_200_000n);         // LKR 12,000.00
    expect(await token.totalShares(1)).to.equal(1000n);
    expect(await token.balanceOf(investor.address, 1)).to.equal(300n);
    expect(await token.balanceOf(owner.address, 1)).to.equal(700n);
    const rec = await vr.getValuation(1, 1);
    expect(rec.previousValuation).to.equal(10_000_000n);
    expect(rec.tokenSupply).to.equal(1000n);
    expect(rec.publisher).to.equal(publisher.address);
  });

  it("VR02: a decrease to 8M gives 8,000 per token", async function () {
    await publish(publisher, 1, 8_000_000n);
    expect(await vr.getReferencePriceCents(1)).to.equal(800_000n);
    expect(await token.balanceOf(investor.address, 1)).to.equal(300n);
  });

  it("VR03: only an authorized publisher can publish (investor, owner, stranger denied)", async function () {
    for (const s of [investor, owner, stranger]) {
      await expect(publish(s, 1, 12_000_000n)).to.be.revertedWithCustomError(vr, "AccessControlUnauthorizedAccount");
    }
    expect((await registry.getAsset(1)).valuationLKR).to.equal(10_000_000n);
  });

  it("VR04: rejects duplicate and out-of-order versions", async function () {
    await expect(publish(publisher, 2, 12_000_000n)).to.be.revertedWith("Version must be the next in sequence");
    await publish(publisher, 1, 12_000_000n);
    await expect(publish(publisher, 1, 13_000_000n)).to.be.revertedWith("Version must be the next in sequence");
    expect(await vr.latestVersion(1)).to.equal(1n);
  });

  it("VR05: rejects invalid amounts, currency, hashes, dates and assets", async function () {
    await expect(publish(publisher, 1, 0n)).to.be.revertedWith("Valuation must be > 0");
    await expect(publish(publisher, 1, 1n, { currency: ethers.encodeBytes32String("USD") })).to.be.revertedWith("Only LKR valuations are supported");
    await expect(publish(publisher, 1, 1n, { report: ethers.ZeroHash })).to.be.revertedWith("Report hash required");
    await expect(publish(publisher, 1, 1n, { date: (await now()) + 86400 })).to.be.revertedWith("Effective date cannot be in the future");
    await expect(publish(publisher, 1, 1n, { assetId: 99 })).to.be.revertedWith("Asset does not exist");
    await registry.connect(owner).registerAsset("Not tokenized", "NT", "ipfs://y", "0xdoc2", 5n, 5n);
    await registry.approveAsset(2);
    await expect(publish(publisher, 1, 6n, { assetId: 2 })).to.be.revertedWith("Asset must be tokenized");
  });

  it("VR06: keeps every version in history; effective dates cannot go backwards", async function () {
    const t = await now();
    await publish(publisher, 1, 12_000_000n, { date: t - 1000 });
    await publish(publisher, 2, 11_500_000n, { date: t - 500 });
    await expect(publish(publisher, 3, 13_000_000n, { date: t - 900 })).to.be.revertedWith("Effective date earlier than previous version");
    const h = await vr.getHistory(1);
    expect(h.map((r) => r.valuation)).to.deep.equal([12_000_000n, 11_500_000n]);
    expect(h[1].previousValuation).to.equal(12_000_000n);
  });

  it("VR07: marketplace trade price is independent of the reference price", async function () {
    const musd = await (await ethers.getContractFactory("MockPaymentToken")).deploy("Mock USD", "mUSD", 6);
    const market = await (await ethers.getContractFactory("TokenMarketplace")).deploy(await token.getAddress(), admin.address, 100);
    await token.connect(investor).setApprovalForAll(await market.getAddress(), true);
    await market.connect(investor).createListing(1, 10, ethers.parseUnits("48", 6), await musd.getAddress(), 0);
    await musd.mint(stranger.address, ethers.parseUnits("1000", 6));
    await musd.connect(stranger).approve(await market.getAddress(), ethers.parseUnits("480", 6));
    await market.connect(stranger).buyListing(1);

    await publish(publisher, 1, 12_000_000n);
    expect(await vr.getReferencePriceCents(1)).to.equal(1_200_000n);
    const [trade] = await market.queryFilter(market.filters.ListingPurchased());
    expect(trade.args.totalPrice / trade.args.amount).to.equal(ethers.parseUnits("48", 6)); // unchanged
  });
});
