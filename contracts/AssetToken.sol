// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IAssetToken.sol";
import "./interfaces/IAssetRegistry.sol";

/**
 * @title AssetToken
 * @dev ERC-1155 Fractional Asset Token representing fractional ownership
 * of verified real-world assets registered in AssetRegistry.
 */
contract AssetToken is ERC1155, Ownable, IAssetToken {
    IAssetRegistry public assetRegistry;

    // assetId => total fraction supply
    mapping(uint256 => uint256) private _totalShares;
    mapping(uint256 => bool) private _isTokenized;
    mapping(uint256 => string) private _assetURIs;

    // Snapshot tracking for Governance & Profit Distribution modules
    // assetId => current snapshot ID
    mapping(uint256 => uint256) public currentSnapshotId;
    // assetId => snapshotId => account => historical balance
    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) private _snapshotBalances;
    // assetId => snapshotId => account => has recorded
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) private _snapshotRecorded;

    // Authorized callers for taking snapshots (e.g. Governance or Profit Distribution contracts)
    mapping(address => bool) public authorizedCallers;

    modifier onlyAdminOrRegistry() {
        require(
            msg.sender == owner() || msg.sender == address(assetRegistry),
            "Caller is not owner or registry"
        );
        _;
    }

    modifier onlyAuthorized() {
        require(
            msg.sender == owner() || authorizedCallers[msg.sender],
            "Not authorized to trigger snapshot"
        );
        _;
    }

    constructor(address _registryAddress) ERC1155("") Ownable(msg.sender) {
        if (_registryAddress != address(0)) {
            assetRegistry = IAssetRegistry(_registryAddress);
        }
    }

    function setAssetRegistry(address _registryAddress) external onlyOwner {
        require(_registryAddress != address(0), "Invalid registry address");
        assetRegistry = IAssetRegistry(_registryAddress);
    }

    function setAuthorizedCaller(address caller, bool isAuth) external onlyOwner {
        authorizedCallers[caller] = isAuth;
    }

    /**
     * @dev Mints fractional ownership tokens for an approved asset in AssetRegistry.
     * @param assetId The ID of the asset in the registry.
     * @param recipient The wallet receiving initial fractional tokens (issuer).
     */
    function tokenizeAsset(
        uint256 assetId,
        address recipient
    ) external override onlyAdminOrRegistry returns (bool) {
        require(address(assetRegistry) != address(0), "AssetRegistry not set");
        require(!_isTokenized[assetId], "Asset already tokenized");
        require(recipient != address(0), "Invalid recipient");

        IAssetRegistry.AssetRecord memory asset = assetRegistry.getAsset(assetId);
        require(asset.status == IAssetRegistry.AssetStatus.Approved, "Asset not approved in registry");
        require(asset.totalShares > 0, "Asset shares must be > 0");

        _totalShares[assetId] = asset.totalShares;
        _isTokenized[assetId] = true;
        _assetURIs[assetId] = asset.metadataURI;

        // Mark asset as tokenized in the registry
        assetRegistry.markTokenized(assetId);

        // Mint all fractional shares to the recipient
        _mint(recipient, assetId, asset.totalShares, "");

        emit AssetTokenized(assetId, recipient, asset.totalShares, asset.metadataURI);
        return true;
    }

    /**
     * @dev Creates a balance snapshot for an asset (used by Governance and Profit Distribution).
     */
    function createSnapshot(uint256 assetId) external override onlyAuthorized returns (uint256) {
        require(_isTokenized[assetId], "Asset not tokenized");
        currentSnapshotId[assetId]++;
        uint256 snapId = currentSnapshotId[assetId];

        emit SnapshotCreated(assetId, snapId, block.number);
        return snapId;
    }

    /**
     * @dev Queries the fractional balance of an investor at a specific snapshot ID.
     */
    function balanceOfAtSnapshot(
        address account,
        uint256 assetId,
        uint256 snapshotId
    ) external view override returns (uint256) {
        require(snapshotId > 0 && snapshotId <= currentSnapshotId[assetId], "Invalid snapshotId");

        if (_snapshotRecorded[assetId][snapshotId][account]) {
            return _snapshotBalances[assetId][snapshotId][account];
        }

        return balanceOf(account, assetId);
    }

    function totalShares(uint256 assetId) external view override returns (uint256) {
        return _totalShares[assetId];
    }

    function isTokenized(uint256 assetId) external view override returns (bool) {
        return _isTokenized[assetId];
    }

    function getAssetRegistry() external view override returns (address) {
        return address(assetRegistry);
    }

    function uri(uint256 assetId) public view override returns (string memory) {
        require(_isTokenized[assetId], "Unknown or untokenized asset");
        return _assetURIs[assetId];
    }

    /**
     * @dev Hook that is called before any token transfer, mint, or burn.
     * Records historical snapshot balances before state modification.
     */
    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal virtual override {
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            uint256 snapId = currentSnapshotId[id];
            if (snapId > 0) {
                if (from != address(0) && !_snapshotRecorded[id][snapId][from]) {
                    _snapshotBalances[id][snapId][from] = balanceOf(from, id);
                    _snapshotRecorded[id][snapId][from] = true;
                }
                if (to != address(0) && !_snapshotRecorded[id][snapId][to]) {
                    _snapshotBalances[id][snapId][to] = balanceOf(to, id);
                    _snapshotRecorded[id][snapId][to] = true;
                }
            }
        }

        super._update(from, to, ids, values);
    }
}
