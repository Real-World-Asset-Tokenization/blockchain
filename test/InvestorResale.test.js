const { expect } = require("chai");
const { ethers } = require("hardhat");

// An investor who bought tokens sells them on to another investor.
describe("Investor resale on TokenMarketplace", function () {
  let registry, token, musd, market, admin, owner, investor, buyer, treasury;
  const u = (n) => ethers.parseUnits(String(n), 6);

  beforeEach(async function () {
    [admin, owner, investor, buyer, treasury] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("AssetRegistry")).deploy();
    token = await (await ethers.getContractFactory("AssetToken")).deploy(await registry.getAddress());
    await registry.setAssetTokenContract(await token.getAddress());
    musd = await (await ethers.getContractFactory("MockPaymentToken")).deploy("Mock USD", "mUSD", 6);
    market = await (await ethers.getContractFactory("TokenMarketplace")).deploy(await token.getAddress(), treasury.address, 100); // 1% fee

    await registry.connect(owner).registerAsset("Galle Villa", "GV", "ipfs://x", "0xabc", 10_000_000n, 1000n);
    await registry.approveAsset(1);
    await token.tokenizeAsset(1, owner.address);
    for (const s of [investor, buyer]) await musd.mint(s.address, u(100_000));

    // Investor buys 100 tokens from the owner at 30 mUSD each.
    await token.connect(owner).setApprovalForAll(await market.getAddress(), true);
    await market.connect(owner).createListing(1, 100, u(30), await musd.getAddress(), 0);
    await musd.connect(investor).approve(await market.getAddress(), u(3000));
    await market.connect(investor).buyListing(1);
  });

  it("TC17: investor lists owned tokens; buyer pays; investor receives proceeds minus fee", async function () {
    expect(await token.balanceOf(investor.address, 1)).to.equal(100n);
    await token.connect(investor).setApprovalForAll(await market.getAddress(), true);
    await market.connect(investor).createListing(1, 40, u(36), await musd.getAddress(), 30 * 86400); // listing #2

    // Non-custodial: tokens stay with the investor until sold.
    expect(await token.balanceOf(investor.address, 1)).to.equal(100n);

    const before = await musd.balanceOf(investor.address);
    await musd.connect(buyer).approve(await market.getAddress(), u(1440));
    await expect(market.connect(buyer).buyListing(2)).to.emit(market, "ListingPurchased");

    expect(await token.balanceOf(investor.address, 1)).to.equal(60n);
    expect(await token.balanceOf(buyer.address, 1)).to.equal(40n);
    // 40 x 36 = 1440; 1% fee = 14.40; investor gets 1425.60
    expect((await musd.balanceOf(investor.address)) - before).to.equal(u("1425.6"));
    // Profit on these 40 tokens: 1425.60 received - 1200 cost = 225.60
  });

  it("TC18: buyer can take part of an offer; the rest stays listed", async function () {
    await token.connect(investor).setApprovalForAll(await market.getAddress(), true);
    await market.connect(investor).createListing(1, 50, u(32), await musd.getAddress(), 0);
    await musd.connect(buyer).approve(await market.getAddress(), u(640));
    await market.connect(buyer).buyListingAmount(2, 20);
    const l = await market.getListing(2);
    expect(l.amount).to.equal(30n);
    expect(l.status).to.equal(0n); // still Active
  });

  it("TC19: investor can cancel; cannot list more than held; cannot list without approval", async function () {
    await expect(market.connect(investor).createListing(1, 10, u(30), await musd.getAddress(), 0))
      .to.be.revertedWith("Marketplace not approved for asset tokens");
    await token.connect(investor).setApprovalForAll(await market.getAddress(), true);
    await expect(market.connect(investor).createListing(1, 101, u(30), await musd.getAddress(), 0))
      .to.be.revertedWith("Insufficient token balance");
    await market.connect(investor).createListing(1, 10, u(30), await musd.getAddress(), 0);
    await expect(market.connect(buyer).cancelListing(2)).to.be.revertedWith("Unauthorized cancellation");
    await market.connect(investor).cancelListing(2);
    await expect(market.connect(buyer).buyListing(2)).to.be.revertedWith("Listing not active");
  });

  it("TC20: a sale fails safely if the seller no longer holds the tokens", async function () {
    await token.connect(investor).setApprovalForAll(await market.getAddress(), true);
    await market.connect(investor).createListing(1, 100, u(30), await musd.getAddress(), 0);
    await token.connect(investor).safeTransferFrom(investor.address, admin.address, 1, 100, "0x");
    await musd.connect(buyer).approve(await market.getAddress(), u(3000));
    await expect(market.connect(buyer).buyListing(2)).to.be.revertedWith("Seller has insufficient asset tokens");
  });
});
