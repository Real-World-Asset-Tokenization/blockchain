// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IAssetToken.sol";

/**
 * @title ProfitDistribution
 * @dev Cryptographically verified, Merkle-based settlement contract for time-weighted RWA profit distributions.
 * Validates off-chain time-weighted dividend allocations using commutative Merkle proofs.
 * Supports multi-round funding reservation, atomic ERC-20 claims, and duplicate-claim prevention.
 */
contract ProfitDistribution is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum RoundStatus { Draft, Approved, Funded, Active, Closed }

    struct DistributionRound {
        uint256 roundId;
        uint256 assetId;
        bytes32 merkleRoot;
        uint256 totalPayout;     // Total approved distributable amount (in payment token units)
        uint256 fundedAmount;    // Actual payment tokens deposited
        uint256 claimedAmount;   // Total payment tokens claimed so far
        bytes32 reportHash;      // Cryptographic hash of approved financial report
        address paymentToken;    // ERC-20 token address used for dividend payout
        uint256 createdAt;
        uint256 activatedAt;
        uint256 closedAt;
        RoundStatus status;
    }

    IAssetToken public immutable assetToken;
    uint256 public nextRoundId = 1;

    // roundId => DistributionRound
    mapping(uint256 => DistributionRound) public rounds;
    // assetId => array of roundIds
    mapping(uint256 => uint256[]) private _assetRounds;

    // roundId => investor => hasClaimed
    mapping(uint256 => mapping(address => bool)) public hasClaimed;
    // roundId => investor => claimedAmount
    mapping(uint256 => mapping(address => uint256)) public claimedAmounts;

    event RoundCreated(
        uint256 indexed roundId,
        uint256 indexed assetId,
        bytes32 merkleRoot,
        uint256 totalPayout,
        bytes32 reportHash,
        address paymentToken
    );

    event RoundApproved(uint256 indexed roundId);

    event RoundFunded(
        uint256 indexed roundId,
        uint256 amountFunded,
        uint256 totalFunded,
        address indexed funder
    );

    event RoundActivated(uint256 indexed roundId, uint256 activatedAt);
    event RoundClosed(uint256 indexed roundId, uint256 unclaimedRefunded);

    event ProfitClaimed(
        uint256 indexed roundId,
        uint256 indexed assetId,
        address indexed claimant,
        uint256 amount
    );

    constructor(address _assetToken) Ownable(msg.sender) {
        require(_assetToken != address(0), "Invalid asset token address");
        assetToken = IAssetToken(_assetToken);
    }

    /**
     * @dev Creates a new distribution round with an approved Merkle Root.
     * Round starts in Approved state if created by owner.
     */
    function createDistributionRound(
        uint256 assetId,
        bytes32 merkleRoot,
        uint256 totalPayout,
        bytes32 reportHash,
        address paymentToken
    ) external onlyOwner returns (uint256) {
        require(assetToken.isTokenized(assetId), "Asset not tokenized");
        require(merkleRoot != bytes32(0), "Invalid Merkle root");
        require(totalPayout > 0, "Total payout must be > 0");
        require(paymentToken != address(0), "Invalid payment token address");

        uint256 roundId = nextRoundId++;

        rounds[roundId] = DistributionRound({
            roundId: roundId,
            assetId: assetId,
            merkleRoot: merkleRoot,
            totalPayout: totalPayout,
            fundedAmount: 0,
            claimedAmount: 0,
            reportHash: reportHash,
            paymentToken: paymentToken,
            createdAt: block.timestamp,
            activatedAt: 0,
            closedAt: 0,
            status: RoundStatus.Approved
        });

        _assetRounds[assetId].push(roundId);

        emit RoundCreated(roundId, assetId, merkleRoot, totalPayout, reportHash, paymentToken);
        emit RoundApproved(roundId);

        return roundId;
    }

    /**
     * @dev Deposits ERC-20 payment tokens to reserve funding for a distribution round.
     */
    function fundDistributionRound(
        uint256 roundId,
        uint256 amount
    ) external nonReentrant {
        DistributionRound storage round = rounds[roundId];
        require(round.roundId != 0, "Round does not exist");
        require(
            round.status == RoundStatus.Approved || round.status == RoundStatus.Funded,
            "Round cannot receive funding in current status"
        );
        require(amount > 0, "Funding amount must be > 0");

        IERC20(round.paymentToken).safeTransferFrom(msg.sender, address(this), amount);
        round.fundedAmount += amount;

        if (round.fundedAmount >= round.totalPayout) {
            round.status = RoundStatus.Funded;
        }

        emit RoundFunded(roundId, amount, round.fundedAmount, msg.sender);
    }

    /**
     * @dev Activates the distribution round so eligible investors can claim their dividends.
     * Requires the round to be fully funded.
     */
    function activateDistributionRound(uint256 roundId) external onlyOwner {
        DistributionRound storage round = rounds[roundId];
        require(round.roundId != 0, "Round does not exist");
        require(
            round.status == RoundStatus.Funded || (round.status == RoundStatus.Approved && round.fundedAmount >= round.totalPayout),
            "Round must be fully funded before activation"
        );

        round.status = RoundStatus.Active;
        round.activatedAt = block.timestamp;

        emit RoundActivated(roundId, block.timestamp);
    }

    /**
     * @dev Computes the leaf hash for a claim.
     * Binds chainId, contract address, assetId, roundId, claimant, and amount
     * to prevent replay across chains, contracts, assets, and rounds.
     * Uses double-hashing to protect against 64-byte preimage attacks.
     */
    function getLeafHash(
        uint256 assetId,
        uint256 roundId,
        address claimant,
        uint256 amount
    ) public view returns (bytes32) {
        return keccak256(
            bytes.concat(
                keccak256(
                    abi.encode(
                        block.chainid,
                        address(this),
                        assetId,
                        roundId,
                        claimant,
                        amount
                    )
                )
            )
        );
    }

    /**
     * @dev Investor claims their time-weighted dividend payout using a Merkle proof.
     */
    function claimProfit(
        uint256 roundId,
        uint256 amount,
        bytes32[] calldata merkleProof
    ) external nonReentrant returns (bool) {
        DistributionRound storage round = rounds[roundId];
        require(round.roundId != 0, "Round does not exist");
        require(round.status == RoundStatus.Active, "Distribution round is not active");
        require(!hasClaimed[roundId][msg.sender], "Profit already claimed for this round");
        require(amount > 0, "Claim amount must be > 0");
        require(
            round.claimedAmount + amount <= round.fundedAmount,
            "Claim exceeds remaining round funding"
        );

        // Verify cryptographic Merkle proof
        bytes32 leaf = getLeafHash(round.assetId, roundId, msg.sender, amount);
        require(
            MerkleProof.verify(merkleProof, round.merkleRoot, leaf),
            "Invalid Merkle proof or incorrect claim entitlement"
        );

        // Checks-Effects-Interactions
        hasClaimed[roundId][msg.sender] = true;
        claimedAmounts[roundId][msg.sender] = amount;
        round.claimedAmount += amount;

        // Transfer payment tokens to investor
        IERC20(round.paymentToken).safeTransfer(msg.sender, amount);

        emit ProfitClaimed(roundId, round.assetId, msg.sender, amount);
        return true;
    }

    /**
     * @dev Closes a distribution round and returns any unclaimed funds to the owner.
     */
    function closeDistributionRound(uint256 roundId) external onlyOwner nonReentrant {
        DistributionRound storage round = rounds[roundId];
        require(round.roundId != 0, "Round does not exist");
        require(round.status == RoundStatus.Active, "Round is not active");

        round.status = RoundStatus.Closed;
        round.closedAt = block.timestamp;

        uint256 unclaimed = round.fundedAmount > round.claimedAmount
            ? round.fundedAmount - round.claimedAmount
            : 0;

        if (unclaimed > 0) {
            IERC20(round.paymentToken).safeTransfer(owner(), unclaimed);
        }

        emit RoundClosed(roundId, unclaimed);
    }

    /**
     * @dev Retrieves distribution round details.
     */
    function getRound(uint256 roundId) external view returns (DistributionRound memory) {
        require(rounds[roundId].roundId != 0, "Round does not exist");
        return rounds[roundId];
    }

    /**
     * @dev Retrieves all round IDs for a given asset.
     */
    function getRoundsByAsset(uint256 assetId) external view returns (uint256[] memory) {
        return _assetRounds[assetId];
    }

    /**
     * @dev Returns true if an investor has claimed their dividend for a specific round.
     */
    function isClaimed(uint256 roundId, address claimant) external view returns (bool) {
        return hasClaimed[roundId][claimant];
    }
}
