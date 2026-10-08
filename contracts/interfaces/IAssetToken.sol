// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

/**
 * @title IAssetToken
 * @dev Shared interface for fractional real-world asset tokens.
 * Used by Marketplace, Governance, and Profit Distribution modules.
 */
interface IAssetToken is IERC1155 {
    event AssetTokenized(
        uint256 indexed assetId,
        address indexed issuer,
        uint256 totalShares,
        string metadataURI
    );

    event SnapshotCreated(
        uint256 indexed assetId,
        uint256 indexed snapshotId,
        uint256 blockNumber
    );

    function tokenizeAsset(uint256 assetId, address recipient) external returns (bool);
    function totalShares(uint256 assetId) external view returns (uint256);
    function isTokenized(uint256 assetId) external view returns (bool);
    function getAssetRegistry() external view returns (address);

    // Snapshot mechanism for Governance & Profit Distribution modules
    function createSnapshot(uint256 assetId) external returns (uint256);
    function balanceOfAtSnapshot(
        address account,
        uint256 assetId,
        uint256 snapshotId
    ) external view returns (uint256);
}
