// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IAssetToken.sol";

/**
 * @title ProfitDistribution
 * @dev Automated rental yield and profit waterfall distribution for tokenized assets.
 * Uses historical balance snapshots to guarantee proportional entitlements, pull-based claims,
 * and prevention of double claims.
 */
contract ProfitDistribution is Ownable, ReentrancyGuard {
    IAssetToken public assetToken;
    uint256 public nextPeriodId = 1;

    struct DistributionPeriod {
        uint256 periodId;
        uint256 assetId;
        uint256 totalAmountWei;
        uint256 claimedAmountWei;
        uint256 totalSharesSnapshot;
        uint256 snapshotId;
        uint256 createdAt;
        string quarterOrTitle;
        bool isActive;
    }

    // periodId => DistributionPeriod
    mapping(uint256 => DistributionPeriod) public periods;
    // periodId => investor => hasClaimed
    mapping(uint256 => mapping(address => bool)) public hasClaimed;
    // periodId => investor => claimedAmount
    mapping(uint256 => mapping(address => uint256)) public claimedAmounts;

    event DistributionFunded(
        uint256 indexed periodId,
        uint256 indexed assetId,
        uint256 totalAmountWei,
        uint256 snapshotId,
        string quarterOrTitle
    );

    event ProfitClaimed(
        uint256 indexed periodId,
        uint256 indexed assetId,
        address indexed investor,
        uint256 amountWei
    );

    constructor(address _assetToken) Ownable(msg.sender) {
        require(_assetToken != address(0), "Invalid asset token address");
        assetToken = IAssetToken(_assetToken);
    }

    function setAssetToken(address _assetToken) external onlyOwner {
        require(_assetToken != address(0), "Invalid asset token address");
        assetToken = IAssetToken(_assetToken);
    }

    /**
     * @dev Deposit rental income / dividends for an asset and create a payout period.
     * Takes an on-chain snapshot of balances via AssetToken.
     */
    function fundDistribution(
        uint256 assetId,
        string calldata quarterOrTitle
    ) external payable nonReentrant returns (uint256) {
        require(msg.value > 0, "Must deposit ETH for distribution");
        require(assetToken.isTokenized(assetId), "Asset not tokenized");

        uint256 snapId = assetToken.createSnapshot(assetId);
        uint256 shares = assetToken.totalShares(assetId);
        require(shares > 0, "Asset shares must be > 0");

        uint256 periodId = nextPeriodId++;
        periods[periodId] = DistributionPeriod({
            periodId: periodId,
            assetId: assetId,
            totalAmountWei: msg.value,
            claimedAmountWei: 0,
            totalSharesSnapshot: shares,
            snapshotId: snapId,
            createdAt: block.timestamp,
            quarterOrTitle: quarterOrTitle,
            isActive: true
        });

        emit DistributionFunded(periodId, assetId, msg.value, snapId, quarterOrTitle);
        return periodId;
    }

    /**
     * @dev Calculates the claimable entitlement for an investor in a given period.
     * entitlement = (totalAmountWei * investorSnapshotBalance) / totalSharesSnapshot
     */
    function getClaimableEntitlement(
        uint256 periodId,
        address investor
    ) public view returns (uint256) {
        DistributionPeriod storage period = periods[periodId];
        if (!period.isActive || hasClaimed[periodId][investor]) {
            return 0;
        }

        uint256 investorShares = assetToken.balanceOfAtSnapshot(investor, period.assetId, period.snapshotId);
        if (investorShares == 0 || period.totalSharesSnapshot == 0) {
            return 0;
        }

        return (period.totalAmountWei * investorShares) / period.totalSharesSnapshot;
    }

    /**
     * @dev Pull-based claim of rental yield dividends. Reentrancy-guarded.
     */
    function claimProfit(uint256 periodId) external nonReentrant returns (uint256) {
        DistributionPeriod storage period = periods[periodId];
        require(period.isActive, "Distribution period not active");
        require(!hasClaimed[periodId][msg.sender], "Already claimed for this period");

        uint256 entitlement = getClaimableEntitlement(periodId, msg.sender);
        require(entitlement > 0, "No claimable entitlement");

        hasClaimed[periodId][msg.sender] = true;
        claimedAmounts[periodId][msg.sender] = entitlement;
        period.claimedAmountWei += entitlement;

        (bool sent, ) = payable(msg.sender).call{value: entitlement}("");
        require(sent, "ETH transfer failed");

        emit ProfitClaimed(periodId, period.assetId, msg.sender, entitlement);
        return entitlement;
    }

    function getPeriod(uint256 periodId) external view returns (DistributionPeriod memory) {
        return periods[periodId];
    }
}
