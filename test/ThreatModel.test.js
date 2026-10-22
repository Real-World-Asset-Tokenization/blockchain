const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// One test per row of docs/THREAT_MODEL.md that is not already proven by another suite.
// Rows marked "known limitation" document behaviour that is accepted and explained, not a guard.
describe("Threat model checks", function () {
  let registry, assetToken, valuation, mUSD, market, sale;
  let admin, owner, a, b, buyer, treasury;
  let chainId;

  const ONE = ethers.parseUnits("1", 6);
  const ASSET = 1n;
  const VALUATION = 10_000_000n; // 10,000 LKR per token over 1,000 tokens; at 100 LKR/USD that is $100
  const SALE_PRICE = 5_000n * ONE;
  const DURATION = 7 * 86400;

  const fixedTypes = { Order: [
    { name: "seller", type: "address" }, { name: "assetId", type: "uint256" }, { name: "amount", type: "uint256" },
    { name: "pricePerToken", type: "uint256" }, { name: "paymentToken", type: "address" },
    { name: "expiry", type: "uint256" }, { name: "salt", type: "uint256" }
  ] };
  const followTypes = { FollowOrder: [
    { name: "seller", type: "address" }, { name: "assetId", type: "uint256" }, { name: "amount", type: "uint256" },
    { name: "premiumBps", type: "int256" }, { name: "floorPrice", type: "uint256" }, { name: "paymentToken", type: "address" },
    { name: "expiry", type: "uint256" }, { name: "salt", type: "uint256" }
  ] };
  const voteTypes = { Vote: [{ name: "offerId", type: "uint256" }, { name: "support", type: "uint8" }] };

  const domainOf = async (name, contract) => ({ name, version: "1", chainId, verifyingContract: await contract.getAddress() });

  async function fixedOrder(signer, target) {
    const order = {
      seller: signer.address, assetId: ASSET, amount: 100n, pricePerToken: 100n * ONE,
      paymentToken: await mUSD.getAddress(), expiry: 0n, salt: 1n
    };
    return { order, signature: await signer.signTypedData(await domainOf("TokenMarketplace", target), fixedTypes, order) };
  }

  beforeEach(async function () {
    [admin, owner, a, b, buyer, treasury] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;

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
    await market.setLkrPerUsd(10000n);
    sale = await (await ethers.getContractFactory("PropertySale")).deploy(await assetToken.getAddress());
    await assetToken.setAuthorizedCaller(await sale.getAddress(), true);

    await registry.connect(owner).registerAsset("Colombo Land", "CLD", "ipfs://colombo", ethers.keccak256(ethers.toUtf8Bytes("deed")), VALUATION, 1000n);
    await registry.approveAsset(1);
    await assetToken.connect(owner).tokenize(1);
    await assetToken.connect(owner).setApprovalForAll(await market.getAddress(), true);
    await assetToken.connect(owner).safeTransferFrom(owner.address, a.address, ASSET, 300n, "0x");
    await assetToken.connect(owner).safeTransferFrom(owner.address, b.address, ASSET, 100n, "0x");

    for (const s of [a, b, buyer]) {
      await mUSD.mint(s.address, 10_000_000n * ONE);
      await mUSD.connect(s).approve(await market.getAddress(), ethers.MaxUint256);
    }
  });

  describe("Orders", function () {
    it("T-O1 domain separation: an order signed for one marketplace cannot be filled on another", async function () {
      const other = await (await ethers.getContractFactory("TokenMarketplace")).deploy(await assetToken.getAddress(), treasury.address, 100);
      await assetToken.connect(owner).setApprovalForAll(await other.getAddress(), true);
      await mUSD.connect(a).approve(await other.getAddress(), ethers.MaxUint256);
      const { order, signature } = await fixedOrder(owner, market);
      await expect(other.connect(a).fillSignedOrder(order, signature, 10n)).to.be.revertedWith("Invalid order signature");
    });

    it("T-O2 a fixed order and a follow order can never share a hash, so one cannot cancel or fill the other", async function () {
      const { order } = await fixedOrder(owner, market);
      const follow = {
        seller: owner.address, assetId: ASSET, amount: 100n, premiumBps: 0n, floorPrice: 0n,
        paymentToken: await mUSD.getAddress(), expiry: 0n, salt: 1n
      };
      expect(await market.hashOrder(order)).to.not.equal(await market.hashFollowOrder(follow));
    });

    it("T-O3 a transfer lock stops marketplace fills while a property sale vote is open", async function () {
      const { order, signature } = await fixedOrder(owner, market);
      await mUSD.mint(buyer.address, SALE_PRICE);
      await mUSD.connect(buyer).approve(await sale.getAddress(), SALE_PRICE);
      await sale.connect(buyer).createOffer(ASSET, await mUSD.getAddress(), SALE_PRICE, DURATION);
      await sale.openVoting(1n);
      await expect(market.connect(a).fillSignedOrder(order, signature, 10n)).to.be.revertedWith("Transfers locked: property sale in progress");
    });
  });

  describe("Price", function () {
    it("T-P1 an exchange-rate change cannot overcharge a buyer who set a price limit", async function () {
      const follow = {
        seller: owner.address, assetId: ASSET, amount: 100n, premiumBps: 0n, floorPrice: 0n,
        paymentToken: await mUSD.getAddress(), expiry: 0n, salt: 1n
      };
      const sig = await owner.signTypedData(await domainOf("TokenMarketplace", market), followTypes, follow);
      await market.setLkrPerUsd(5000n); // rate halves, dollar price doubles
      await expect(market.connect(a).fillFollowOrder(follow, sig, 10n, 100n * ONE)).to.be.revertedWith("Price above buyer limit");
    });

    it("T-P2 only the platform owner can change the exchange rate or the valuation source", async function () {
      await expect(market.connect(a).setLkrPerUsd(1n)).to.be.reverted;
      await expect(market.connect(a).setValuationRegistry(a.address)).to.be.reverted;
    });

    it("T-P3 only the valuation publisher can publish a revaluation, and versions cannot be skipped or repeated", async function () {
      const stamp = BigInt(await time.latest());
      const call = (signer, v) => valuation.connect(signer).publishValuation(ASSET, v, VALUATION * 2n, ethers.encodeBytes32String("LKR"), stamp, ethers.keccak256("0x01"), ethers.keccak256("0x02"));
      await expect(call(a, 1n)).to.be.reverted;
      await expect(call(admin, 2n)).to.be.revertedWith("Version must be the next in sequence");
      await call(admin, 1n);
      await expect(call(admin, 1n)).to.be.revertedWith("Version must be the next in sequence");
      expect(await valuation.latestVersion(ASSET)).to.equal(1n);
    });

    it("T-P4 KNOWN LIMITATION: the registry owner can change a valuation directly, without a published version", async function () {
      const follow = {
        seller: owner.address, assetId: ASSET, amount: 100n, premiumBps: 0n, floorPrice: 0n,
        paymentToken: await mUSD.getAddress(), expiry: 0n, salt: 1n
      };
      expect(await market.followPrice(follow)).to.equal(100n * ONE);
      await registry.updateAssetValuation(ASSET, VALUATION * 3n); // bypasses AssetValuationRegistry
      expect(await market.followPrice(follow)).to.equal(300n * ONE);
      expect(await valuation.latestVersion(ASSET)).to.equal(0n); // no audit record was written
    });
  });

  describe("Property sale", function () {
    const castSig = async (signer, offerId, support) =>
      signer.signTypedData(await domainOf("PropertySale", sale), voteTypes, { offerId, support });

    beforeEach(async function () {
      await mUSD.mint(buyer.address, 2n * SALE_PRICE);
      await mUSD.connect(buyer).approve(await sale.getAddress(), 2n * SALE_PRICE);
      await sale.connect(buyer).createOffer(ASSET, await mUSD.getAddress(), SALE_PRICE, DURATION);
      await sale.connect(buyer).createOffer(ASSET, await mUSD.getAddress(), SALE_PRICE, DURATION);
    });

    it("T-S1 a signed vote for one sale offer cannot be replayed on another", async function () {
      await sale.openVoting(1n);
      const sig = await castSig(a, 1n, 1);
      expect(await sale.connect(admin).castVotesBySig.staticCall(2n, [1], [sig])).to.equal(0n);
      expect(await sale.connect(admin).castVotesBySig.staticCall(1n, [1], [sig])).to.equal(1n);
    });

    it("T-S2 voting power is fixed at the snapshot: tokens received later carry no vote", async function () {
      await sale.openVoting(1n);
      await expect(assetToken.connect(a).safeTransferFrom(a.address, buyer.address, ASSET, 50n, "0x"))
        .to.be.revertedWith("Transfers locked: property sale in progress");
      expect(await sale.votingPowerBps(1n, buyer.address)).to.equal(0n);
    });

    it("T-S3 a holder cannot vote twice, directly or with a signed vote", async function () {
      await sale.openVoting(1n);
      await sale.connect(a).castVote(1n, 1);
      await expect(sale.connect(a).castVote(1n, 1)).to.be.revertedWith("Vote not accepted");
      const sig = await castSig(a, 1n, 0);
      expect(await sale.connect(admin).castVotesBySig.staticCall(1n, [0], [sig])).to.equal(0n);
    });

    it("T-S4 KNOWN LIMITATION: an approved sale keeps transfers locked until the platform confirms or cancels it", async function () {
      await sale.openVoting(1n);
      await sale.connect(owner).castVote(1n, 1); // the owner's 600 tokens are more than half
      await sale.finalize(1n);
      await time.increase(DURATION * 10);
      await expect(assetToken.connect(a).safeTransferFrom(a.address, b.address, ASSET, 1n, "0x"))
        .to.be.revertedWith("Transfers locked: property sale in progress");
      await expect(sale.connect(a).cancelOffer(1n)).to.be.reverted; // holders cannot unlock it themselves
      await sale.cancelOffer(1n); // only the platform can
      await assetToken.connect(a).safeTransferFrom(a.address, b.address, ASSET, 1n, "0x");
    });

    it("T-S5 KNOWN LIMITATION: the payout root is published by the platform and not checked against balances on-chain", async function () {
      await sale.openVoting(1n);
      await sale.connect(owner).castVote(1n, 1);
      await sale.finalize(1n);
      // Any non-zero root is accepted. The guard is that claims can never exceed the escrowed price.
      await sale.confirmSale(1n, ethers.keccak256("0x1234"));
      expect((await sale.getOffer(1n)).claimedAmount).to.equal(0n);
      await expect(sale.connect(a).claim(1n, SALE_PRICE + 1n, [])).to.be.revertedWith("Claim exceeds escrowed price");
    });
  });
});
