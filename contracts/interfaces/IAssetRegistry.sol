// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAssetRegistry {
    enum AssetStatus {
        Pending,
        Approved,
        Tokenized,
        Rejected
    }

    struct AssetRecord {
        uint256 assetId;
        string name;
        string symbol;
        string metadataURI;       // IPFS or HTTP URI pointing to full asset metadata
        string documentHash;      // Cryptographic hash of deed/legal proof documents
        uint256 valuationLKR;     // Simulated property valuation
        uint256 totalShares;      // Total fractional ownership units
        address issuer;           // Property owner / submitter
        AssetStatus status;       // Verification status
        uint256 createdAt;        // Timestamp
        uint256 tokenizedAt;      // Timestamp when tokenized
    }

    event AssetRegistered(
        uint256 indexed assetId,
        address indexed issuer,
        string name,
        uint256 valuationLKR,
        uint256 totalShares,
        string metadataURI,
        string documentHash
    );

    event AssetApproved(uint256 indexed assetId, address indexed verifier);
    event AssetRejected(uint256 indexed assetId, address indexed verifier, string reason);
    event AssetMarkedTokenized(uint256 indexed assetId, address indexed tokenContract);

    function registerAsset(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        string calldata documentHash,
        uint256 valuationLKR,
        uint256 totalShares
    ) external returns (uint256);

    function approveAsset(uint256 assetId) external;
    function rejectAsset(uint256 assetId, string calldata reason) external;
    function markTokenized(uint256 assetId) external;

    function getAsset(uint256 assetId) external view returns (AssetRecord memory);
    function isAssetApproved(uint256 assetId) external view returns (bool);
    function isAssetTokenized(uint256 assetId) external view returns (bool);
}
