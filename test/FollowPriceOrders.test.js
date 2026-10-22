const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Offers that follow the property's approved price: the price is worked out when someone buys,
// from the valuation published on-chain, so a revaluation moves every open offer.
describe("Offers that follow the approved price", function () {
  let registry, assetToken, valuation, mUSD, market;
  let admin, owner, a, b, treasury;
  let chainId;

  const ONE = ethers.parseUnits("1", 6);
  const ASSET = 1n;
  // 10,000,000 LKR over 1,000 tokens = 10,000 LKR per token. At 100 LKR per USD that is $100 per token.
  const VALUATION = 10_000_000n;
  const TOKENS = 1000n;

  const followTypes = {
    FollowOrder: [
      { name: "seller", type: "address" },
      { name: "assetId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "premiumBps", type: "int256" },
      { name: "floorPrice", type: "uint256" },
      { name: "paymentToken", type: "address" },
      { name: "expiry", type: "uint256" },
      { name: "salt", type: "uint256" }
    ]
  };

  async function sign(signer, fields = {}) {
    const order = {
      seller: signer.address,
      assetId: ASSET,
      amount: 100n,
      premiumBps: 0n,
      floorPrice: 0n,
      paymentToken: await mUSD.getAddress(),
      expiry: 0n,
      salt: 1n,
      ...fields
    };
    const domain = { name: "TokenMarketplace", version: "1", chainId, verifyingContract: await market.getAddress() };
    return { order, signature: await signer.signTypedData(domain, followTypes, order) };
  }

  let version = 0;
  async function revalue(newValuation) {
    version += 1;
    await valuation.publishValuation(
      ASSET, version, newValuation, ethers.encodeBytes32String("LKR"), BigInt(await time.latest()),
      ethers.keccak256(ethers.toUtf8Bytes(`report-${version}`)), ethers.keccak256(ethers.toUtf8Bytes(`proposal-${version}`))
    );
  }

  beforeEach(async function () {
    [admin, owner, a, b, treasury] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;
    version = 0;

    registry = await (await ethers.getContractFactory("AssetRegistry")).deploy();
    assetToken = await (await ethers.getContractFactory("AssetToken")).deploy(await registry.getAddress());
    await registry.setAssetTokenContract(await assetToken.getAddress());
    valuation = await (await ethers.getContractFactory("AssetValuationRegistry")).deploy(
      await registry.getAddress(), await assetToken.getAddress(), admin.address
    );
    await registry.setAuthorizedVerifier(await valuation.getAddress(), true);
    mUSD = await (await ethers.getContractFactory("MockPaymentToken")).deploy("Mock USD", "mUSD", 6);
    market = await (await ethers.getContractFactory("TokenMarketplace")).deploy(await assetToken.getAddress(), treasury.address, 100);
    await market.setValuationRegistry(await valuation.getAddress());
    await market.setLkrPerUsd(10000n); // 100.00 LKR per USD keeps the numbers round

    await registry.connect(owner).registerAsset("Colombo Land", "CLD", "ipfs://colombo", ethers.keccak256(ethers.toUtf8Bytes("deed")), VALUATION, TOKENS);
    await registry.approveAsset(1);
    await assetToken.connect(owner).tokenize(1);
    await assetToken.connect(owner).setApprovalForAll(await market.getAddress(), true);

    for (const s of [a, b]) {
      await mUSD.mint(s.address, 1_000_000n * ONE);
      await mUSD.connect(s).approve(await market.getAddress(), ethers.MaxUint256);
    }
  });

  describe("price", function () {
    it("equals the approved price per token, read from the valuation registry", async function () {
      expect(await market.referencePrice(ASSET)).to.equal(100n * ONE);
      const { order } = await sign(owner);
      expect(await market.followPrice(order)).to.equal(100n * ONE);
    });

    it("applies the premium above and below the approved price", async function () {
      expect(await market.followPrice((await sign(owner, { premiumBps: 500n })).order)).to.equal(105n * ONE);
      expect(await market.followPrice((await sign(owner, { premiumBps: -1000n })).order)).to.equal(90n * ONE);
    });

    it("rises by itself when the property is revalued, with the same signed offer", async function () {
      const { order, signature } = await sign(owner);
      expect(await market.followPrice(order)).to.equal(100n * ONE);

      await revalue(VALUATION * 2n); // land value doubles
      expect(await market.followPrice(order)).to.equal(200n * ONE);

      const before = await mUSD.balanceOf(owner.address);
      await market.connect(a).fillFollowOrder(order, signature, 10n, 200n * ONE);
      // 10 tokens at the new $200, minus the 1% platform fee
      expect((await mUSD.balanceOf(owner.address)) - before).to.equal(10n * 200n * ONE * 99n / 100n);
    });

    it("falls with a lower valuation, but never below the seller's floor", async function () {
      const { order } = await sign(owner, { floorPrice: 80n * ONE });
      await revalue((VALUATION * 90n) / 100n); // $90
      expect(await market.followPrice(order)).to.equal(90n * ONE);
      await revalue((VALUATION * 60n) / 100n); // $60, under the floor
      await expect(market.followPrice(order)).to.be.revertedWith("Price below seller minimum");
    });

    it("follows the exchange rate the platform sets", async function () {
      await market.setLkrPerUsd(20000n); // 200 LKR per USD halves the dollar price
      expect(await market.referencePrice(ASSET)).to.equal(50n * ONE);
    });

    it("rejects a premium outside the allowed range", async function () {
      const { order } = await sign(owner, { premiumBps: -5001n });
      await expect(market.followPrice(order)).to.be.revertedWith("Premium out of range");
    });
  });

  describe("buying", function () {
    it("moves tokens and mUSD and records the fill like a normal signed order", async function () {
      const { order, signature } = await sign(owner);
      await expect(market.connect(a).fillFollowOrder(order, signature, 25n, 100n * ONE)).to.emit(market, "SignedOrderFilled");
      expect(await assetToken.balanceOf(a.address, ASSET)).to.equal(25n);
      expect(await market.orderFilled(await market.hashFollowOrder(order))).to.equal(25n);
    });

    it("protects the buyer: reverts when the price is above their limit", async function () {
      const { order, signature } = await sign(owner);
      await revalue(VALUATION * 2n);
      await expect(market.connect(a).fillFollowOrder(order, signature, 10n, 100n * ONE)).to.be.revertedWith("Price above buyer limit");
    });

    it("never fills more than the signed amount, across several buyers", async function () {
      const { order, signature } = await sign(owner);
      await market.connect(a).fillFollowOrder(order, signature, 60n, 100n * ONE);
      await market.connect(b).fillFollowOrder(order, signature, 40n, 100n * ONE);
      await expect(market.connect(b).fillFollowOrder(order, signature, 1n, 100n * ONE)).to.be.revertedWith("Invalid purchase amount");
    });

    it("rejects a changed order and a signature from someone else", async function () {
      const { order, signature } = await sign(owner);
      await expect(market.connect(a).fillFollowOrder({ ...order, premiumBps: -4000n }, signature, 10n, 100n * ONE)).to.be.revertedWith("Invalid order signature");
      const forged = await sign(a, { seller: owner.address });
      await expect(market.connect(b).fillFollowOrder(forged.order, forged.signature, 10n, 100n * ONE)).to.be.revertedWith("Invalid order signature");
    });

    it("buys with a permit sized to the buyer's price limit", async function () {
      await mUSD.connect(a).approve(await market.getAddress(), 0n);
      const { order, signature } = await sign(owner);
      const limit = 110n * ONE;
      const deadline = BigInt((await time.latest()) + 3600);
      const domain = { name: "Mock USD", version: "1", chainId, verifyingContract: await mUSD.getAddress() };
      const types = { Permit: [
        { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }
      ] };
      const nonce = await mUSD.nonces(a.address);
      const sig = ethers.Signature.from(await a.signTypedData(domain, types, {
        owner: a.address, spender: await market.getAddress(), value: 10n * limit, nonce, deadline
      }));
      await market.connect(a).fillFollowOrderWithPermit(order, signature, 10n, limit, deadline, sig.v, sig.r, sig.s);
      expect(await assetToken.balanceOf(a.address, ASSET)).to.equal(10n);
    });

    it("rejects the seller buying their own offer and an expired offer", async function () {
      const { order, signature } = await sign(owner);
      await expect(market.connect(owner).fillFollowOrder(order, signature, 1n, 100n * ONE)).to.be.revertedWith("Seller cannot purchase own order");
      const expiring = await sign(owner, { expiry: BigInt((await time.latest()) + 100), salt: 2n });
      await time.increase(200);
      await expect(market.connect(a).fillFollowOrder(expiring.order, expiring.signature, 1n, 100n * ONE)).to.be.revertedWith("Order expired");
    });
  });

  describe("cancelling and setup", function () {
    it("lets the seller cancel, and nobody else", async function () {
      const { order, signature } = await sign(owner);
      await expect(market.connect(a).cancelFollowOrder(order)).to.be.revertedWith("Unauthorized cancellation");
      await expect(market.connect(owner).cancelFollowOrder(order)).to.emit(market, "SignedOrderCancelled");
      await expect(market.connect(a).fillFollowOrder(order, signature, 1n, 100n * ONE)).to.be.revertedWith("Order cancelled");
    });

    it("only the platform owner can set the registry and the rate", async function () {
      await expect(market.connect(a).setValuationRegistry(a.address)).to.be.reverted;
      await expect(market.connect(a).setLkrPerUsd(1n)).to.be.reverted;
      await expect(market.setLkrPerUsd(0n)).to.be.revertedWith("Rate must be above zero");
    });

    it("refuses to price an offer when no valuation registry is set", async function () {
      const bare = await (await ethers.getContractFactory("TokenMarketplace")).deploy(await assetToken.getAddress(), treasury.address, 100);
      await expect(bare.referencePrice(ASSET)).to.be.revertedWith("Valuation registry not set");
    });
  });
});
