// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IAssetToken.sol";

/**
 * @title AssetGovernance
 * @dev On-chain token-weighted governance for fractional real-world assets.
 * Utilizes snapshot balances to prevent double voting and post-snapshot transfer manipulation.
 */
contract AssetGovernance is Ownable, ReentrancyGuard {
    IAssetToken public assetToken;
    uint256 public nextProposalId = 1;

    enum ProposalStatus { Active, Passed, Rejected, Executed }

    struct Proposal {
        uint256 proposalId;
        uint256 assetId;
        address proposer;
        string description;
        uint256 snapshotId;
        uint256 startBlock;
        uint256 endBlock;
        uint256 yesVotes;
        uint256 noVotes;
        uint256 abstainVotes;
        uint256 totalWeightVoted;
        bool finalized;
        ProposalStatus status;
    }

    // proposalId => Proposal
    mapping(uint256 => Proposal) public proposals;
    // proposalId => voter => hasVoted
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    // proposalId => voter => vote choice (1: YES, 2: NO, 3: ABSTAIN)
    mapping(uint256 => mapping(address => uint8)) public voteChoice;

    event ProposalCreated(
        uint256 indexed proposalId,
        uint256 indexed assetId,
        address indexed proposer,
        string description,
        uint256 snapshotId,
        uint256 startBlock,
        uint256 endBlock
    );

    event VoteCast(
        uint256 indexed proposalId,
        address indexed voter,
        uint8 support,
        uint256 weight
    );

    event ProposalFinalized(uint256 indexed proposalId, ProposalStatus status, uint256 yesVotes, uint256 noVotes);

    constructor(address _assetToken) Ownable(msg.sender) {
        require(_assetToken != address(0), "Invalid asset token address");
        assetToken = IAssetToken(_assetToken);
    }

    function setAssetToken(address _assetToken) external onlyOwner {
        require(_assetToken != address(0), "Invalid asset token address");
        assetToken = IAssetToken(_assetToken);
    }

    /**
     * @dev Creates a proposal for an asset. Takes a balance snapshot via AssetToken.
     * @param assetId The asset ID for the proposal.
     * @param description Brief description of proposed action (e.g. lease renegotiation, renovation).
     * @param votingDurationBlocks Number of blocks the vote remains open.
     */
    function createProposal(
        uint256 assetId,
        string calldata description,
        uint256 votingDurationBlocks
    ) external nonReentrant returns (uint256) {
        require(assetToken.isTokenized(assetId), "Asset not tokenized");
        require(bytes(description).length > 0, "Description required");
        require(votingDurationBlocks > 0, "Duration must be > 0");

        // The proposer must hold shares in the asset
        require(assetToken.balanceOf(msg.sender, assetId) > 0, "Proposer must hold asset shares");

        // Take snapshot on AssetToken
        uint256 snapId = assetToken.createSnapshot(assetId);

        uint256 proposalId = nextProposalId++;
        proposals[proposalId] = Proposal({
            proposalId: proposalId,
            assetId: assetId,
            proposer: msg.sender,
            description: description,
            snapshotId: snapId,
            startBlock: block.number,
            endBlock: block.number + votingDurationBlocks,
            yesVotes: 0,
            noVotes: 0,
            abstainVotes: 0,
            totalWeightVoted: 0,
            finalized: false,
            status: ProposalStatus.Active
        });

        emit ProposalCreated(
            proposalId,
            assetId,
            msg.sender,
            description,
            snapId,
            block.number,
            block.number + votingDurationBlocks
        );

        return proposalId;
    }

    /**
     * @dev Casts a vote on a proposal.
     * Voting power is determined by snapshot balance on AssetToken.
     * @param support 1 = YES, 2 = NO, 3 = ABSTAIN
     */
    function castVote(uint256 proposalId, uint8 support) external nonReentrant {
        Proposal storage p = proposals[proposalId];
        require(p.proposalId != 0, "Proposal not found");
        require(block.number <= p.endBlock, "Voting period ended");
        require(!p.finalized, "Proposal already finalized");
        require(!hasVoted[proposalId][msg.sender], "Already voted on this proposal");
        require(support >= 1 && support <= 3, "Invalid support choice (1=Yes, 2=No, 3=Abstain)");

        uint256 weight = assetToken.balanceOfAtSnapshot(msg.sender, p.assetId, p.snapshotId);
        require(weight > 0, "No voting weight at proposal snapshot");

        hasVoted[proposalId][msg.sender] = true;
        voteChoice[proposalId][msg.sender] = support;
        p.totalWeightVoted += weight;

        if (support == 1) {
            p.yesVotes += weight;
        } else if (support == 2) {
            p.noVotes += weight;
        } else if (support == 3) {
            p.abstainVotes += weight;
        }

        emit VoteCast(proposalId, msg.sender, support, weight);
    }

    /**
     * @dev Finalizes a proposal after deadline or admin call.
     */
    function finalizeProposal(uint256 proposalId) external nonReentrant returns (ProposalStatus) {
        Proposal storage p = proposals[proposalId];
        require(p.proposalId != 0, "Proposal not found");
        require(!p.finalized, "Already finalized");
        require(block.number > p.endBlock || msg.sender == owner(), "Voting still active");

        p.finalized = true;
        uint256 totalAssetShares = assetToken.totalShares(p.assetId);

        // Simple majority with quorum rule:
        // Quorum: at least 20% of total shares participated
        // Majority: yesVotes > noVotes
        bool quorumMet = (p.totalWeightVoted * 100) / totalAssetShares >= 20;

        if (quorumMet && p.yesVotes > p.noVotes) {
            p.status = ProposalStatus.Passed;
        } else {
            p.status = ProposalStatus.Rejected;
        }

        emit ProposalFinalized(proposalId, p.status, p.yesVotes, p.noVotes);
        return p.status;
    }

    function getProposal(uint256 proposalId) external view returns (Proposal memory) {
        return proposals[proposalId];
    }
}
