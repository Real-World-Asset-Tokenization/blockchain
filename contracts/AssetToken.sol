// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IAssetToken.sol";
import "./interfaces/IAssetRegistry.sol";

/**
 * @title AssetToken
 * @dev ERC-1155 Fractional Asset Token representing fractional ownership
 * of verified real-world assets registered in AssetRegistry.
 */
contract AssetToken is ERC1155, Ownable, ReentrancyGuard, IAssetToken {
    IAssetRegistry public assetRegistry;

    // assetId => total fraction supply
    mapping(uint256 => uint256) private _totalShares;
    mapping(uint256 => bool) private _isTokenized;
    mapping(uint256 => string) private _assetURIs;

    // Snapshot tracking for Governance & Profit Distribution modules
    // assetId => current snapshot ID
    mapping(uint256 => uint256) public currentSnapshotId;

    // Per-account balance checkpoints (same design as OpenZeppelin's ERC20Snapshot). Before an account's
    // balance changes, its balance is recorded once per snapshot. A lookup for snapshot N reads the first
    // checkpoint with id >= N, so it stays correct even when several snapshots were taken between
    // the account's transfers.
    struct Checkpoints {
        uint256[] ids;
        uint256[] values;
    }
    // assetId => account => checkpoints
    mapping(uint256 => mapping(address => Checkpoints)) private _checkpoints;

    // Authorized callers for taking snapshots (e.g. Governance or Profit Distribution contracts)
    mapping(address => bool) public authorizedCallers;

    // assetId => holder-to-holder transfers frozen (set while a full-property sale is in progress)
    mapping(uint256 => bool) public override transfersLocked;

    event TransfersLockChanged(uint256 indexed assetId, bool locked);

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
     * Enforces that only the verified asset owner (or platform admin) can initiate tokenization,
     * and tokens are minted directly into the verified asset owner's wallet.
     * @param assetId The ID of the asset in the registry.
     * @param recipient The wallet receiving initial fractional tokens (must match asset.issuer).
     */
    function tokenizeAsset(
        uint256 assetId,
        address recipient
    ) public override nonReentrant returns (bool) {
        require(address(assetRegistry) != address(0), "AssetRegistry not set");

        IAssetRegistry.AssetRecord memory asset = assetRegistry.getAsset(assetId);
        require(asset.assetId != 0, "Asset does not exist");

        // Fail-fast authorization check: Caller must be verified owner, contract owner, or registry
        if (msg.sender == asset.issuer) {
            require(recipient == asset.issuer, "Recipient must be verified asset owner");
        } else {
            require(
                msg.sender == owner() || msg.sender == address(assetRegistry),
                "Caller is not authorized asset owner or admin"
            );
            require(recipient != address(0), "Invalid recipient");
        }

        // Asset lifecycle state checks
        require(!_isTokenized[assetId], "Asset already tokenized");
        require(asset.status == IAssetRegistry.AssetStatus.Approved, "Asset not approved in registry");
        require(asset.totalShares > 0, "Asset shares must be > 0");

        _totalShares[assetId] = asset.totalShares;
        _isTokenized[assetId] = true;
        _assetURIs[assetId] = asset.metadataURI;

        // Atomically mark asset as tokenized in the registry
        assetRegistry.markTokenized(assetId);

        // Mint all fractional shares directly to the verified owner
        _mint(recipient, assetId, asset.totalShares, "");

        emit AssetTokenized(assetId, recipient, asset.totalShares, asset.metadataURI);
        return true;
    }

    /**
     * @dev Owner-initiated tokenization where recipient is automatically the verified owner.
     * @param assetId The ID of the asset in the registry.
     */
    function tokenize(uint256 assetId) public override returns (bool) {
        require(address(assetRegistry) != address(0), "AssetRegistry not set");
        IAssetRegistry.AssetRecord memory asset = assetRegistry.getAsset(assetId);
        return tokenizeAsset(assetId, asset.issuer);
    }

    /**
     * @dev Alias for tokenize(uint256 assetId).
     */
    function tokenizeAssetByOwner(uint256 assetId) external override returns (bool) {
        return tokenize(assetId);
    }

    /**
     * @dev Queries the initial reference price calculated by AssetRegistry: Valuation / TotalShares.
     * @param assetId The ID of the asset.
     */
    function getInitialReferencePrice(uint256 assetId) external view override returns (uint256) {
        require(address(assetRegistry) != address(0), "AssetRegistry not set");
        return assetRegistry.getInitialReferencePrice(assetId);
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
     * @dev Freezes or unfreezes transfers between holders of an asset. Minting is not affected.
     * The sale contract locks transfers while owners vote so the vote snapshot and the payout
     * snapshot stay identical.
     */
    function setTransfersLocked(uint256 assetId, bool locked) external override onlyAuthorized {
        require(_isTokenized[assetId], "Asset not tokenized");
        transfersLocked[assetId] = locked;
        emit TransfersLockChanged(assetId, locked);
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

        Checkpoints storage cp = _checkpoints[assetId][account];
        uint256 idx = _upperBound(cp.ids, snapshotId);
        // No checkpoint at or after this snapshot: the balance has not changed since, so it is the current one.
        return idx == cp.ids.length ? balanceOf(account, assetId) : cp.values[idx];
    }

    /// @dev Index of the first element of the ascending array `ids` that is >= `target`, or ids.length.
    function _upperBound(uint256[] storage ids, uint256 target) private view returns (uint256) {
        uint256 low = 0;
        uint256 high = ids.length;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (ids[mid] < target) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        return low;
    }

    function _recordCheckpoint(uint256 assetId, address account, uint256 snapId) private {
        Checkpoints storage cp = _checkpoints[assetId][account];
        uint256 n = cp.ids.length;
        if (n == 0 || cp.ids[n - 1] < snapId) {
            cp.ids.push(snapId);
            cp.values.push(balanceOf(account, assetId));
        }
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
            require(
                from == address(0) || to == address(0) || !transfersLocked[id],
                "Transfers locked: property sale in progress"
            );
            uint256 snapId = currentSnapshotId[id];
            if (snapId > 0) {
                if (from != address(0)) _recordCheckpoint(id, from, snapId);
                if (to != address(0)) _recordCheckpoint(id, to, snapId);
            }
        }

        super._update(from, to, ids, values);
    }
}
