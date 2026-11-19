const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Regression tests for the issues found in the pre-launch security review.
describe("Security hardening", function () {
  const ASSET = 1n;
  const ONE = 1_000_000n; // mUSD has 6 decimals
  const DAY = 24 * 3600;
  let registry, assetToken, mUSD, sale;
  let admin, owner, a, b, buyer, stranger;

  beforeEach(async function () {
    [admin, owner, a, b, buyer, stranger] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("AssetRegistry")).deploy();
    assetToken = await (await ethers.getContractFactory("AssetToken")).deploy(await registry.getAddress());
    await registry.setAssetTokenContract(await assetToken.getAddress());
    mUSD = await (await ethers.getContractFactory("MockPaymentToken")).deploy("Mock USD", "mUSD", 6);
    sale = await (await ethers.getContractFactory("PropertySale")).deploy(await assetToken.getAddress());
    await assetToken.setAuthorizedCaller(await sale.getAddress(), true);

    await registry.connect(owner).registerAsset("Colombo Land", "CLD", "ipfs://x", ethers.keccak256(ethers.toUtf8Bytes("deed")), 10000000n, 1000n);
    await registry.approveAsset(1);
    await assetToken.connect(owner).tokenize(1);
  });

  describe("MockPaymentToken", function () {
    it("only the owner can mint", async function () {
      await expect(mUSD.connect(stranger).mint(stranger.address, 1n * ONE)).to.be.reverted;
      await mUSD.connect(admin).mint(stranger.address, 1n * ONE);
      expect(await mUSD.balanceOf(stranger.address)).to.equal(1n * ONE);
    });
  });

  describe("AssetToken snapshots across several snapshots", function () {
    it("keeps an old snapshot correct after later snapshots and transfers (no double entitlement)", async function () {
      await assetToken.connect(owner).safeTransferFrom(owner.address, a.address, ASSET, 100n, "0x");

      await assetToken.createSnapshot(ASSET); // snapshot 1: a holds 100
      await assetToken.createSnapshot(ASSET); // snapshot 2 taken before a moves anything

      await assetToken.connect(a).safeTransferFrom(a.address, b.address, ASSET, 100n, "0x");

      // Snapshot 1 and 2 both still say a held 100 and b held 0, even though balances moved afterwards.
      for (const snap of [1, 2]) {
        expect(await assetToken.balanceOfAtSnapshot(a.address, ASSET, snap)).to.equal(100n);
        expect(await assetToken.balanceOfAtSnapshot(b.address, ASSET, snap)).to.equal(0n);
      }

      await assetToken.createSnapshot(ASSET); // snapshot 3 sees the new balances
      expect(await assetToken.balanceOfAtSnapshot(a.address, ASSET, 3)).to.equal(0n);
      expect(await assetToken.balanceOfAtSnapshot(b.address, ASSET, 3)).to.equal(100n);
    });

    it("tracks an account that changes balance between snapshots", async function () {
      await assetToken.connect(owner).safeTransferFrom(owner.address, a.address, ASSET, 50n, "0x");
      await assetToken.createSnapshot(ASSET); // 1: a=50
      await assetToken.connect(owner).safeTransferFrom(owner.address, a.address, ASSET, 25n, "0x");
      await assetToken.createSnapshot(ASSET); // 2: a=75
      await assetToken.connect(a).safeTransferFrom(a.address, b.address, ASSET, 75n, "0x");
      await assetToken.createSnapshot(ASSET); // 3: a=0

      expect(await assetToken.balanceOfAtSnapshot(a.address, ASSET, 1)).to.equal(50n);
      expect(await assetToken.balanceOfAtSnapshot(a.address, ASSET, 2)).to.equal(75n);
      expect(await assetToken.balanceOfAtSnapshot(a.address, ASSET, 3)).to.equal(0n);
    });
  });

  describe("PropertySale", function () {
    const PRICE = 1_000_000n * ONE;

    async function makeOffer(duration) {
      await mUSD.mint(buyer.address, PRICE);
      await mUSD.connect(buyer).approve(await sale.getAddress(), PRICE);
      return sale.connect(buyer).createOffer(ASSET, await mUSD.getAddress(), PRICE, duration);
    }

    it("rejects an unbounded voting duration", async function () {
      await expect(makeOffer(31 * DAY)).to.be.revertedWith("Voting duration too long");
      await makeOffer(30 * DAY);
    });

    it("lets anyone return the escrow when an approved sale is never settled", async function () {
      await makeOffer(7 * DAY);
      await sale.openVoting(1);
      await sale.connect(owner).castVote(1, 1); // owner holds 100% and votes yes
      await sale.finalize(1);

      await expect(sale.connect(stranger).reclaimStaleApproval(1)).to.be.revertedWith("Settlement deadline not reached");

      await time.increase(90 * DAY + 1);
      await sale.connect(stranger).reclaimStaleApproval(1);

      expect(await mUSD.balanceOf(buyer.address)).to.equal(PRICE);
      expect((await sale.getOffer(1)).status).to.equal(6n); // Cancelled
      // Trading is unfrozen again.
      await assetToken.connect(owner).safeTransferFrom(owner.address, a.address, ASSET, 10n, "0x");
    });

    it("does not let a settled or pending offer be reclaimed this way", async function () {
      await makeOffer(7 * DAY);
      await time.increase(90 * DAY + 1);
      await expect(sale.reclaimStaleApproval(1)).to.be.revertedWith("Offer is not approved");
    });
  });
});
