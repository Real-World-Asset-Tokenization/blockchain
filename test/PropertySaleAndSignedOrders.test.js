const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { hashLeaf, MerkleTree } = require("./helpers/merkleHelper");

describe("Signed marketplace orders, resale royalty and full-property sale", function () {
  let registry, assetToken, mUSD, market, sale;
  let admin, owner, a, b, c, d, treasury, buyer;
  let chainId;

  const ONE = ethers.parseUnits("1", 6);
  const PRICE = 100n * ONE;
  const ASSET = 1n;

  const orderTypes = {
    Order: [
      { name: "seller", type: "address" },
      { name: "assetId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "pricePerToken", type: "uint256" },
      { name: "paymentToken", type: "address" },
      { name: "expiry", type: "uint256" },
      { name: "salt", type: "uint256" }
    ]
  };
  const voteTypes = {
    Vote: [
      { name: "offerId", type: "uint256" },
      { name: "support", type: "uint8" }
    ]
  };

  async function signOrder(signer, fields) {
    const order = {
      seller: signer.address,
      assetId: ASSET,
      amount: 100n,
      pricePerToken: PRICE,
      paymentToken: await mUSD.getAddress(),
      expiry: 0n,
      salt: 1n,
      ...fields
    };
    const domain = { name: "TokenMarketplace", version: "1", chainId, verifyingContract: await market.getAddress() };
    return { order, signature: await signer.signTypedData(domain, orderTypes, order) };
  }

  async function signVote(signer, offerId, support) {
    const domain = { name: "PropertySale", version: "1", chainId, verifyingContract: await sale.getAddress() };
    return signer.signTypedData(domain, voteTypes, { offerId, support });
  }

  beforeEach(async function () {
    [admin, owner, a, b, c, d, treasury, buyer] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;

    registry = await (await ethers.getContractFactory("AssetRegistry")).deploy();
    assetToken = await (await ethers.getContractFactory("AssetToken")).deploy(await registry.getAddress());
    await registry.setAssetTokenContract(await assetToken.getAddress());
    mUSD = await (await ethers.getContractFactory("MockPaymentToken")).deploy("Mock USD", "mUSD", 6);
    market = await (await ethers.getContractFactory("TokenMarketplace")).deploy(await assetToken.getAddress(), treasury.address, 100);
    sale = await (await ethers.getContractFactory("PropertySale")).deploy(await assetToken.getAddress());
    await assetToken.setAuthorizedCaller(await sale.getAddress(), true);

    // The issuer is the asset owner; they receive all 1,000 tokens.
    await registry.connect(owner).registerAsset("Colombo Land", "CLD", "ipfs://colombo", ethers.keccak256(ethers.toUtf8Bytes("deed")), 10000000n, 1000n);
    await registry.approveAsset(1);
    await assetToken.connect(owner).tokenize(1);

    for (const s of [a, b, c, d, buyer]) await mUSD.mint(s.address, 1_000_000n * ONE);
  });

  describe("Signed (off-chain) orders", function () {
    beforeEach(async function () {
      await assetToken.connect(owner).setApprovalForAll(await market.getAddress(), true);
    });

    it("settles a signed primary sale without the seller sending a listing transaction", async function () {
      const { order, signature } = await signOrder(owner, {});
      await mUSD.connect(a).approve(await market.getAddress(), 100n * PRICE);

      await expect(market.connect(a).fillSignedOrder(order, signature, 100n)).to.emit(market, "SignedOrderFilled");

      expect(await assetToken.balanceOf(a.address, ASSET)).to.equal(100n);
      expect(await assetToken.balanceOf(owner.address, ASSET)).to.equal(900n);
      expect(await market.totalListings()).to.equal(0n); // nothing was stored as an on-chain listing
      expect(await mUSD.balanceOf(treasury.address)).to.equal((100n * PRICE) / 100n); // 1% platform fee
    });

    it("allows partial fills and rejects filling more than was signed", async function () {
      const { order, signature } = await signOrder(owner, {});
      await mUSD.connect(a).approve(await market.getAddress(), 100n * PRICE);
      await mUSD.connect(b).approve(await market.getAddress(), 100n * PRICE);

      await market.connect(a).fillSignedOrder(order, signature, 60n);
      await market.connect(b).fillSignedOrder(order, signature, 40n);
      await expect(market.connect(b).fillSignedOrder(order, signature, 1n)).to.be.revertedWith("Invalid purchase amount");
    });

    it("rejects a signature from someone other than the seller", async function () {
      const { order, signature } = await signOrder(a, { seller: owner.address });
      await mUSD.connect(b).approve(await market.getAddress(), 100n * PRICE);
      await expect(market.connect(b).fillSignedOrder(order, signature, 10n)).to.be.revertedWith("Invalid order signature");
    });

    it("rejects an order whose terms were changed after signing", async function () {
      const { order, signature } = await signOrder(owner, {});
      await mUSD.connect(a).approve(await market.getAddress(), 100n * PRICE);
      const cheaper = { ...order, pricePerToken: 1n };
      await expect(market.connect(a).fillSignedOrder(cheaper, signature, 10n)).to.be.revertedWith("Invalid order signature");
    });

    it("rejects expired and cancelled orders", async function () {
      const now = await time.latest();
      const expiring = await signOrder(owner, { expiry: BigInt(now + 100), salt: 2n });
      const cancelled = await signOrder(owner, { salt: 3n });
      await mUSD.connect(a).approve(await market.getAddress(), 100n * PRICE);

      await market.connect(owner).cancelSignedOrder(cancelled.order);
      await expect(market.connect(a).fillSignedOrder(cancelled.order, cancelled.signature, 10n)).to.be.revertedWith("Order cancelled");

      await time.increase(200);
      await expect(market.connect(a).fillSignedOrder(expiring.order, expiring.signature, 10n)).to.be.revertedWith("Order expired");
    });

    async function signPermit(signer, value, deadline) {
      const domain = { name: "Mock USD", version: "1", chainId, verifyingContract: await mUSD.getAddress() };
      const types = {
        Permit: [
          { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }
        ]
      };
      const nonce = await mUSD.nonces(signer.address);
      return ethers.Signature.from(
        await signer.signTypedData(domain, types, { owner: signer.address, spender: await market.getAddress(), value, nonce, deadline })
      );
    }

    it("buys with an off-chain permit and needs no separate approve transaction", async function () {
      const { order, signature } = await signOrder(owner, {});
      const deadline = BigInt((await time.latest()) + 3600);
      const permit = await signPermit(a, 10n * PRICE, deadline);
      expect(await mUSD.allowance(a.address, await market.getAddress())).to.equal(0n);

      await market.connect(a).fillSignedOrderWithPermit(order, signature, 10n, deadline, permit.v, permit.r, permit.s);
      expect(await assetToken.balanceOf(a.address, ASSET)).to.equal(10n);
    });

    it("still buys when the permit was already used but the allowance exists", async function () {
      const { order, signature } = await signOrder(owner, {});
      await mUSD.connect(a).approve(await market.getAddress(), 10n * PRICE);
      const deadline = BigInt((await time.latest()) + 3600);
      const stale = await signPermit(b, 10n * PRICE, deadline); // signed by someone else: the permit call fails and is ignored
      await market.connect(a).fillSignedOrderWithPermit(order, signature, 10n, deadline, stale.v, stale.r, stale.s);
      expect(await assetToken.balanceOf(a.address, ASSET)).to.equal(10n);
    });

    it("rejects a purchase whose permit is invalid and that has no allowance", async function () {
      const { order, signature } = await signOrder(owner, {});
      const deadline = BigInt((await time.latest()) + 3600);
      const wrong = await signPermit(b, 10n * PRICE, deadline);
      await expect(
        market.connect(a).fillSignedOrderWithPermit(order, signature, 10n, deadline, wrong.v, wrong.r, wrong.s)
      ).to.be.revertedWith("Buyer insufficient payment allowance");
    });

    it("only the seller or the platform can cancel an order", async function () {
      const { order } = await signOrder(owner, {});
      await expect(market.connect(a).cancelSignedOrder(order)).to.be.revertedWith("Unauthorized cancellation");
    });

    it("rejects a seller buying their own order", async function () {
      const { order, signature } = await signOrder(owner, {});
      await expect(market.connect(owner).fillSignedOrder(order, signature, 10n)).to.be.revertedWith("Seller cannot purchase own order");
    });
  });

  describe("Resale royalty to the original owner", function () {
    beforeEach(async function () {
      await assetToken.connect(owner).setApprovalForAll(await market.getAddress(), true);
      await assetToken.connect(a).setApprovalForAll(await market.getAddress(), true);
      await market.setRoyaltyBps(200); // 2%
    });

    it("pays no royalty on the owner's own primary sale", async function () {
      const { order, signature } = await signOrder(owner, {});
      await mUSD.connect(a).approve(await market.getAddress(), 100n * PRICE);
      const before = await mUSD.balanceOf(owner.address);
      await market.connect(a).fillSignedOrder(order, signature, 100n);
      // seller receives price minus the 1% platform fee only
      expect((await mUSD.balanceOf(owner.address)) - before).to.equal(100n * PRICE - (100n * PRICE) / 100n);
    });

    it("pays the original owner a royalty when an investor resells", async function () {
      await assetToken.connect(owner).safeTransferFrom(owner.address, a.address, ASSET, 100n, "0x");
      const resalePrice = 120n * ONE;
      const { order, signature } = await signOrder(a, { pricePerToken: resalePrice });
      await mUSD.connect(b).approve(await market.getAddress(), 100n * resalePrice);

      const ownerBefore = await mUSD.balanceOf(owner.address);
      const sellerBefore = await mUSD.balanceOf(a.address);
      const total = 100n * resalePrice;
      await expect(market.connect(b).fillSignedOrder(order, signature, 100n)).to.emit(market, "RoyaltyPaid");

      expect((await mUSD.balanceOf(owner.address)) - ownerBefore).to.equal((total * 200n) / 10000n);
      expect((await mUSD.balanceOf(a.address)) - sellerBefore).to.equal(total - total / 100n - (total * 200n) / 10000n);
    });

    it("applies the royalty to on-chain listings too", async function () {
      await assetToken.connect(owner).safeTransferFrom(owner.address, a.address, ASSET, 100n, "0x");
      await market.connect(a).createListing(1, 100n, PRICE, await mUSD.getAddress(), 0);
      await mUSD.connect(b).approve(await market.getAddress(), 100n * PRICE);
      const ownerBefore = await mUSD.balanceOf(owner.address);
      await market.connect(b).buyListing(1);
      expect((await mUSD.balanceOf(owner.address)) - ownerBefore).to.equal((100n * PRICE * 200n) / 10000n);
    });

    it("caps the royalty and restricts who can change it", async function () {
      await expect(market.setRoyaltyBps(1001)).to.be.revertedWith("Royalty exceeds maximum basis points");
      await expect(market.connect(a).setRoyaltyBps(100)).to.be.reverted;
    });
  });

  describe("Full-property sale: escrow, voting and payout", function () {
    // Holdings after distribution: owner 400, a 200, b 150, c 150, d 100 (total 1,000)
    const HOLDINGS = () => [[owner, 400n], [a, 200n], [b, 150n], [c, 150n], [d, 100n]];
    const SALE_PRICE = 15_000_000n * ONE;
    const DURATION = 7 * 24 * 3600;
    let offerId;

    beforeEach(async function () {
      for (const [holder, amount] of HOLDINGS()) {
        if (holder !== owner) await assetToken.connect(owner).safeTransferFrom(owner.address, holder.address, ASSET, amount, "0x");
      }
      await mUSD.mint(buyer.address, SALE_PRICE);
      await mUSD.connect(buyer).approve(await sale.getAddress(), SALE_PRICE);
      await sale.connect(buyer).createOffer(ASSET, await mUSD.getAddress(), SALE_PRICE, DURATION);
      offerId = 1n;
    });

    it("escrows the price and does not freeze trading until the platform opens voting", async function () {
      expect(await mUSD.balanceOf(await sale.getAddress())).to.equal(SALE_PRICE);
      await assetToken.connect(a).safeTransferFrom(a.address, b.address, ASSET, 10n, "0x"); // still tradable
      await expect(sale.connect(a).openVoting(offerId)).to.be.reverted; // not the platform
    });

    it("freezes holder transfers while voting and unfreezes after a rejection", async function () {
      await sale.openVoting(offerId);
      await expect(
        assetToken.connect(a).safeTransferFrom(a.address, b.address, ASSET, 10n, "0x")
      ).to.be.revertedWith("Transfers locked: property sale in progress");

      await time.increase(DURATION + 1);
      await sale.finalize(offerId);
      await assetToken.connect(a).safeTransferFrom(a.address, b.address, ASSET, 10n, "0x");
    });

    it("needs more than 50% of ALL tokens, not 50% of the votes cast", async function () {
      await sale.openVoting(offerId);
      await sale.connect(d).castVote(offerId, 1); // 100 yes of 1,000 -> 10%
      await expect(sale.finalize(offerId)).to.be.revertedWith("Voting still open");

      await time.increase(DURATION + 1);
      await sale.finalize(offerId);
      expect((await sale.getOffer(offerId)).status).to.equal(4n); // Rejected
    });

    it("passes as soon as yes votes exceed half of all tokens", async function () {
      await sale.openVoting(offerId);
      await sale.connect(owner).castVote(offerId, 1); // 400
      await sale.connect(a).castVote(offerId, 1);     // 200 -> 600 of 1,000
      await sale.finalize(offerId);
      const offer = await sale.getOffer(offerId);
      expect(offer.status).to.equal(3n); // Approved
      expect(offer.yesVotes).to.equal(600n);
    });

    it("exactly 50% is not enough", async function () {
      await sale.openVoting(offerId);
      await sale.connect(owner).castVote(offerId, 1); // 400
      await sale.connect(d).castVote(offerId, 1);     // 100 -> exactly 500 of 1,000
      await expect(sale.finalize(offerId)).to.be.revertedWith("Voting still open");

      await time.increase(DURATION + 1);
      await sale.finalize(offerId);
      expect((await sale.getOffer(offerId)).status).to.equal(4n); // Rejected
    });

    it("rejects early once enough tokens vote no that approval is impossible", async function () {
      await sale.openVoting(offerId);
      await sale.connect(owner).castVote(offerId, 2); // 400 no
      await sale.connect(a).castVote(offerId, 2);     // 200 no
      await sale.connect(d).castVote(offerId, 2);     // 100 no -> 700 no
      await sale.finalize(offerId);
      expect((await sale.getOffer(offerId)).status).to.equal(4n); // Rejected, voting window still open
    });

    it("blocks double votes, late votes and holders with no tokens at the snapshot", async function () {
      await sale.openVoting(offerId);
      await sale.connect(a).castVote(offerId, 1);
      await expect(sale.connect(a).castVote(offerId, 1)).to.be.revertedWith("Vote not accepted");
      await expect(sale.connect(buyer).castVote(offerId, 1)).to.be.revertedWith("Vote not accepted");
      await expect(sale.connect(b).castVote(offerId, 7)).to.be.revertedWith("Vote not accepted");
      await time.increase(DURATION + 1);
      await expect(sale.connect(b).castVote(offerId, 1)).to.be.revertedWith("Vote not accepted");
    });

    it("counts signed votes submitted together by any relayer and skips bad entries", async function () {
      await sale.openVoting(offerId);
      const sigs = [
        await signVote(owner, offerId, 1),
        await signVote(a, offerId, 1),
        await signVote(b, offerId, 2),
        await signVote(buyer, offerId, 1) // holds no tokens: skipped
      ];
      const choices = [1, 1, 2, 1];
      // a duplicate of owner's vote is also skipped
      sigs.push(sigs[0]);
      choices.push(1);

      await expect(sale.connect(d).castVotesBySig(offerId, choices, sigs))
        .to.emit(sale, "VoteCast");
      const offer = await sale.getOffer(offerId);
      expect(offer.yesVotes).to.equal(600n);
      expect(offer.noVotes).to.equal(150n);
    });

    it("rejects a signed vote replayed with a different choice", async function () {
      await sale.openVoting(offerId);
      const yesSig = await signVote(a, offerId, 1);
      // Same signature, claiming a "no": the recovered signer is a different (random) address with no tokens.
      await sale.connect(d).castVotesBySig(offerId, [2], [yesSig]);
      const offer = await sale.getOffer(offerId);
      expect(offer.yesVotes + offer.noVotes).to.equal(0n);
    });

    it("pays every holder by snapshot balance after the platform confirms the legal transfer", async function () {
      await sale.openVoting(offerId);
      await sale.connect(owner).castVote(offerId, 1);
      await sale.connect(a).castVote(offerId, 1);
      await sale.finalize(offerId);

      const holders = HOLDINGS();
      const saleAddress = await sale.getAddress();
      const payouts = holders.map(([, amount]) => (SALE_PRICE * amount) / 1000n);
      const tree = new MerkleTree(holders.map(([h], i) => hashLeaf(chainId, saleAddress, ASSET, offerId, h.address, payouts[i])));

      await expect(sale.connect(a).claim(offerId, payouts[1], tree.getProof(1))).to.be.revertedWith("Sale is not settled");
      await expect(sale.connect(a).confirmSale(offerId, tree.getRoot())).to.be.reverted; // not the platform
      await sale.confirmSale(offerId, tree.getRoot());

      // d never voted and still receives their 10%
      for (let i = 0; i < holders.length; i++) {
        const [holder] = holders[i];
        await sale.connect(holder).claim(offerId, payouts[i], tree.getProof(i));
        expect(await mUSD.balanceOf(holder.address)).to.be.gte(payouts[i]);
      }
      expect((await sale.getOffer(offerId)).claimedAmount).to.equal(SALE_PRICE);
      await expect(sale.connect(d).claim(offerId, payouts[4], tree.getProof(4))).to.be.revertedWith("Already claimed");
    });

    it("refuses a claim with the wrong amount", async function () {
      await sale.openVoting(offerId);
      await sale.connect(owner).castVote(offerId, 1);
      await sale.connect(a).castVote(offerId, 1);
      await sale.finalize(offerId);
      const holders = HOLDINGS();
      const saleAddress = await sale.getAddress();
      const payouts = holders.map(([, amount]) => (SALE_PRICE * amount) / 1000n);
      const tree = new MerkleTree(holders.map(([h], i) => hashLeaf(chainId, saleAddress, ASSET, offerId, h.address, payouts[i])));
      await sale.confirmSale(offerId, tree.getRoot());
      await expect(sale.connect(d).claim(offerId, payouts[4] + 1n, tree.getProof(4))).to.be.revertedWith("Invalid Merkle proof");
    });

    it("returns the escrow to the buyer after a rejection", async function () {
      await sale.openVoting(offerId);
      await time.increase(DURATION + 1);
      await sale.finalize(offerId);
      const before = await mUSD.balanceOf(buyer.address);
      await expect(sale.connect(a).withdrawOffer(offerId)).to.be.revertedWith("Only the buyer can withdraw");
      await sale.connect(buyer).withdrawOffer(offerId);
      expect((await mUSD.balanceOf(buyer.address)) - before).to.equal(SALE_PRICE);
      expect((await sale.getOffer(offerId)).status).to.equal(6n); // Cancelled
    });

    it("lets the platform cancel an approved sale (legal transfer failed), refund and unfreeze", async function () {
      await sale.openVoting(offerId);
      await sale.connect(owner).castVote(offerId, 1);
      await sale.connect(a).castVote(offerId, 1);
      await sale.finalize(offerId);

      const before = await mUSD.balanceOf(buyer.address);
      await sale.cancelOffer(offerId);
      expect((await mUSD.balanceOf(buyer.address)) - before).to.equal(SALE_PRICE);
      await assetToken.connect(b).safeTransferFrom(b.address, c.address, ASSET, 10n, "0x");
    });

    it("allows only one live sale per asset", async function () {
      await mUSD.mint(buyer.address, SALE_PRICE);
      await mUSD.connect(buyer).approve(await sale.getAddress(), SALE_PRICE);
      await sale.connect(buyer).createOffer(ASSET, await mUSD.getAddress(), SALE_PRICE, DURATION);
      await sale.openVoting(1n);
      await expect(sale.openVoting(2n)).to.be.revertedWith("Another sale is already live for this asset");
    });
  });
});
