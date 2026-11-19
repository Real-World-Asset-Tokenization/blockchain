// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IAssetToken.sol";

/**
 * @title PropertySale
 * @dev Full-property sale: a buyer escrows the price, token holders vote, and once the platform
 * confirms the legal transfer the escrowed price is paid out to holders by Merkle claim.
 *
 *   Pending  -> buyer has escrowed the price; the platform has not opened voting yet
 *   Voting   -> holder-to-holder transfers are frozen and votes are counted against a snapshot
 *   Approved -> more than 50% of ALL tokens voted yes; waiting for the legal transfer
 *   Rejected -> voting ended without a majority; the buyer can take the escrow back
 *   Settled  -> the platform confirmed the legal transfer and published the payout root
 *   Cancelled-> escrow returned to the buyer
 *
 * Votes can be cast directly or signed off-chain (EIP-712) and submitted in one batch transaction.
 * A passed vote does not move legal ownership; the platform only calls confirmSale after the
 * legal and payment conditions are met.
 */
contract PropertySale is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    enum OfferStatus { None, Pending, Voting, Approved, Rejected, Settled, Cancelled }

    struct Offer {
        uint256 offerId;
        uint256 assetId;
        address buyer;
        address paymentToken;
        uint256 price;           // held in escrow in full from the moment the offer exists
        uint256 votingDuration;  // seconds the vote stays open once voting is opened
        uint256 votingEndsAt;
        uint256 snapshotId;
        uint256 yesVotes;
        uint256 noVotes;
        bytes32 merkleRoot;      // payout allocations, published when the sale is settled
        uint256 claimedAmount;
        OfferStatus status;
    }

    uint8 public constant VOTE_YES = 1;
    uint8 public constant VOTE_NO = 2;

    bytes32 public constant VOTE_TYPEHASH = keccak256("Vote(uint256 offerId,uint8 support)");

    IAssetToken public immutable assetToken;
    uint256 public nextOfferId = 1;

    mapping(uint256 => Offer) public offers;
    // assetId => offer currently in Voting or Approved (only one sale can be live per asset)
    mapping(uint256 => uint256) public liveOfferOf;
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    event OfferCreated(
        uint256 indexed offerId,
        uint256 indexed assetId,
        address indexed buyer,
        address paymentToken,
        uint256 price,
        uint256 votingDuration
    );
    event VotingOpened(uint256 indexed offerId, uint256 indexed assetId, uint256 snapshotId, uint256 votingEndsAt);
    event VoteCast(uint256 indexed offerId, address indexed voter, uint8 support, uint256 weight);
    event OfferFinalized(uint256 indexed offerId, OfferStatus status, uint256 yesVotes, uint256 noVotes);
    event SaleSettled(uint256 indexed offerId, bytes32 merkleRoot);
    event SaleClaimed(uint256 indexed offerId, address indexed claimant, uint256 amount);
    event OfferCancelled(uint256 indexed offerId, uint256 refunded);

    constructor(address _assetToken) Ownable(msg.sender) EIP712("PropertySale", "1") {
        require(_assetToken != address(0), "Invalid asset token address");
        assetToken = IAssetToken(_assetToken);
    }

    // ------------------------------------------------------------------ buyer

    /**
     * @dev A buyer offers `price` for the whole property and escrows it immediately.
     * The offer cannot freeze trading by itself: the platform opens voting after vetting it.
     */
    function createOffer(
        uint256 assetId,
        address paymentToken,
        uint256 price,
        uint256 votingDuration
    ) external nonReentrant returns (uint256) {
        require(assetToken.isTokenized(assetId), "Asset not tokenized");
        require(paymentToken != address(0), "Invalid payment token");
        require(price > 0, "Price must be > 0");
        require(votingDuration > 0, "Voting duration must be > 0");

        IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), price);

        uint256 offerId = nextOfferId++;
        offers[offerId] = Offer({
            offerId: offerId,
            assetId: assetId,
            buyer: msg.sender,
            paymentToken: paymentToken,
            price: price,
            votingDuration: votingDuration,
            votingEndsAt: 0,
            snapshotId: 0,
            yesVotes: 0,
            noVotes: 0,
            merkleRoot: bytes32(0),
            claimedAmount: 0,
            status: OfferStatus.Pending
        });

        emit OfferCreated(offerId, assetId, msg.sender, paymentToken, price, votingDuration);
        return offerId;
    }

    /**
     * @dev The buyer takes the escrow back while the offer is Pending or after it was Rejected.
     */
    function withdrawOffer(uint256 offerId) external nonReentrant {
        Offer storage offer = offers[offerId];
        require(offer.status == OfferStatus.Pending || offer.status == OfferStatus.Rejected, "Offer cannot be withdrawn");
        require(msg.sender == offer.buyer, "Only the buyer can withdraw");
        _refund(offer);
    }

    // --------------------------------------------------------------- platform

    /**
     * @dev Platform opens voting: takes the balance snapshot and freezes transfers of the asset so
     * the vote and the payout are computed on the same balances.
     */
    function openVoting(uint256 offerId) external onlyOwner {
        Offer storage offer = offers[offerId];
        require(offer.status == OfferStatus.Pending, "Offer is not pending");
        require(liveOfferOf[offer.assetId] == 0, "Another sale is already live for this asset");

        offer.snapshotId = assetToken.createSnapshot(offer.assetId);
        assetToken.setTransfersLocked(offer.assetId, true);
        offer.votingEndsAt = block.timestamp + offer.votingDuration;
        offer.status = OfferStatus.Voting;
        liveOfferOf[offer.assetId] = offerId;

        emit VotingOpened(offerId, offer.assetId, offer.snapshotId, offer.votingEndsAt);
    }

    /**
     * @dev Platform confirms the legal transfer and payment conditions are met and publishes the
     * payout allocations (price x snapshot balance / total supply for every holder, who all get
     * paid whether or not they voted yes). Transfers stay frozen because the property is sold.
     */
    function confirmSale(uint256 offerId, bytes32 merkleRoot) external onlyOwner {
        Offer storage offer = offers[offerId];
        require(offer.status == OfferStatus.Approved, "Offer is not approved");
        require(merkleRoot != bytes32(0), "Invalid Merkle root");

        offer.merkleRoot = merkleRoot;
        offer.status = OfferStatus.Settled;

        emit SaleSettled(offerId, merkleRoot);
    }

    /**
     * @dev Platform cancels an offer (for example when the legal transfer fails) and returns the
     * escrow to the buyer. Trading is unfrozen if voting had been opened.
     */
    function cancelOffer(uint256 offerId) external onlyOwner nonReentrant {
        Offer storage offer = offers[offerId];
        require(
            offer.status == OfferStatus.Pending ||
                offer.status == OfferStatus.Voting ||
                offer.status == OfferStatus.Approved,
            "Offer cannot be cancelled"
        );
        _refund(offer);
    }

    // ----------------------------------------------------------------- voting

    function castVote(uint256 offerId, uint8 support) external nonReentrant {
        require(_tryVote(offerId, msg.sender, support), "Vote not accepted");
    }

    /**
     * @dev Submits many off-chain signed votes in one transaction. Any account can relay them.
     * An entry that cannot be counted (bad signature, already voted, no balance at the snapshot)
     * is skipped so one bad entry cannot block the rest. Returns how many were counted.
     */
    function castVotesBySig(
        uint256 offerId,
        uint8[] calldata choices,
        bytes[] calldata signatures
    ) external nonReentrant returns (uint256 counted) {
        require(choices.length == signatures.length, "Length mismatch");
        for (uint256 i = 0; i < choices.length; i++) {
            bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(VOTE_TYPEHASH, offerId, choices[i])));
            (address voter, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, signatures[i]);
            if (err != ECDSA.RecoverError.NoError) continue;
            if (_tryVote(offerId, voter, choices[i])) counted++;
        }
    }

    function _tryVote(uint256 offerId, address voter, uint8 support) internal returns (bool) {
        Offer storage offer = offers[offerId];
        if (offer.status != OfferStatus.Voting || block.timestamp > offer.votingEndsAt) return false;
        if (hasVoted[offerId][voter]) return false;
        if (support != VOTE_YES && support != VOTE_NO) return false;

        uint256 weight = assetToken.balanceOfAtSnapshot(voter, offer.assetId, offer.snapshotId);
        if (weight == 0) return false;

        hasVoted[offerId][voter] = true;
        if (support == VOTE_YES) {
            offer.yesVotes += weight;
        } else {
            offer.noVotes += weight;
        }

        emit VoteCast(offerId, voter, support, weight);
        return true;
    }

    /**
     * @dev Anyone can finalize. Approval needs yes votes above 50% of ALL tokens (not of the votes
     * cast), so it can be decided as soon as that is reached or can no longer be reached.
     */
    function finalize(uint256 offerId) external nonReentrant returns (OfferStatus) {
        Offer storage offer = offers[offerId];
        require(offer.status == OfferStatus.Voting, "Offer is not in voting");

        uint256 supply = assetToken.totalShares(offer.assetId);

        if (offer.yesVotes * 2 > supply) {
            offer.status = OfferStatus.Approved;
        } else if (offer.noVotes * 2 >= supply || block.timestamp > offer.votingEndsAt) {
            offer.status = OfferStatus.Rejected;
            liveOfferOf[offer.assetId] = 0;
            assetToken.setTransfersLocked(offer.assetId, false);
        } else {
            revert("Voting still open");
        }

        emit OfferFinalized(offerId, offer.status, offer.yesVotes, offer.noVotes);
        return offer.status;
    }

    // ----------------------------------------------------------------- payout

    function getLeafHash(
        uint256 assetId,
        uint256 offerId,
        address claimant,
        uint256 amount
    ) public view returns (bytes32) {
        return keccak256(
            bytes.concat(keccak256(abi.encode(block.chainid, address(this), assetId, offerId, claimant, amount)))
        );
    }

    /**
     * @dev A holder claims their share of the sale price with a Merkle proof.
     */
    function claim(uint256 offerId, uint256 amount, bytes32[] calldata merkleProof) external nonReentrant {
        Offer storage offer = offers[offerId];
        require(offer.status == OfferStatus.Settled, "Sale is not settled");
        require(!hasClaimed[offerId][msg.sender], "Already claimed");
        require(amount > 0, "Claim amount must be > 0");
        require(offer.claimedAmount + amount <= offer.price, "Claim exceeds escrowed price");

        bytes32 leaf = getLeafHash(offer.assetId, offerId, msg.sender, amount);
        require(MerkleProof.verify(merkleProof, offer.merkleRoot, leaf), "Invalid Merkle proof");

        hasClaimed[offerId][msg.sender] = true;
        offer.claimedAmount += amount;

        IERC20(offer.paymentToken).safeTransfer(msg.sender, amount);
        emit SaleClaimed(offerId, msg.sender, amount);
    }

    // ------------------------------------------------------------------ views

    function getOffer(uint256 offerId) external view returns (Offer memory) {
        require(offers[offerId].offerId != 0, "Offer does not exist");
        return offers[offerId];
    }

    /**
     * @dev Voting power as a percentage of total supply, in basis points, for an account at the snapshot.
     */
    function votingPowerBps(uint256 offerId, address account) external view returns (uint256) {
        Offer storage offer = offers[offerId];
        require(offer.snapshotId != 0, "Voting not opened");
        uint256 supply = assetToken.totalShares(offer.assetId);
        return (assetToken.balanceOfAtSnapshot(account, offer.assetId, offer.snapshotId) * 10000) / supply;
    }

    // --------------------------------------------------------------- internal

    function _refund(Offer storage offer) internal {
        if (offer.status == OfferStatus.Voting || offer.status == OfferStatus.Approved) {
            liveOfferOf[offer.assetId] = 0;
            assetToken.setTransfersLocked(offer.assetId, false);
        }
        offer.status = OfferStatus.Cancelled;
        IERC20(offer.paymentToken).safeTransfer(offer.buyer, offer.price);
        emit OfferCancelled(offer.offerId, offer.price);
    }
}
