// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "./interfaces/IAssetRegistry.sol";
import "./interfaces/IAssetToken.sol";

/**
 * @title AssetValuationRegistry
 * @dev Versioned, authorized record of approved property revaluations.
 *
 * Each publication:
 *  - must come from an account with VALUATION_PUBLISHER_ROLE (the platform backend
 *    after an off-chain proposal has been approved by an authorized approver);
 *  - must use the next version number for the asset (no duplicates, no gaps, no reordering);
 *  - updates AssetRegistry.valuationLKR in the same transaction, so every existing
 *    reader of the registry sees the new value. This contract must be an authorized
 *    verifier on AssetRegistry.
 *
 * It never mints, burns or transfers tokens. Token supply is read only to record
 * the supply the reference price was based on.
 *
 * Version 0 is the valuation the asset was registered with; the first revaluation is version 1.
 */
contract AssetValuationRegistry is AccessControl {
    bytes32 public constant VALUATION_PUBLISHER_ROLE = keccak256("VALUATION_PUBLISHER_ROLE");
    bytes32 public constant CURRENCY_LKR = "LKR";

    IAssetRegistry public immutable assetRegistry;
    IAssetToken public immutable assetToken;

    struct ValuationRecord {
        uint64 version;
        uint256 valuation;        // whole currency units (LKR)
        bytes32 currency;         // "LKR"
        uint64 effectiveDate;     // unix seconds, date of the valuer's report
        bytes32 reportHash;       // hash of the supporting valuation document
        bytes32 proposalRef;      // hash of the off-chain proposal id (audit link)
        uint256 previousValuation;
        uint256 tokenSupply;      // issued supply at publication (unchanged by this call)
        address publisher;
        uint64 publishedAt;
    }

    mapping(uint256 => ValuationRecord[]) private _history;

    event ValuationPublished(
        uint256 indexed assetId,
        uint64 indexed version,
        uint256 previousValuation,
        uint256 newValuation,
        uint256 tokenSupply,
        bytes32 currency,
        uint64 effectiveDate,
        bytes32 reportHash,
        bytes32 indexed proposalRef,
        address publisher
    );

    constructor(address registry, address token, address admin) {
        require(registry != address(0) && token != address(0) && admin != address(0), "Zero address");
        assetRegistry = IAssetRegistry(registry);
        assetToken = IAssetToken(token);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(VALUATION_PUBLISHER_ROLE, admin);
    }

    function publishValuation(
        uint256 assetId,
        uint64 version,
        uint256 newValuation,
        bytes32 currency,
        uint64 effectiveDate,
        bytes32 reportHash,
        bytes32 proposalRef
    ) external onlyRole(VALUATION_PUBLISHER_ROLE) {
        require(newValuation > 0, "Valuation must be > 0");
        require(currency == CURRENCY_LKR, "Only LKR valuations are supported");
        require(reportHash != bytes32(0), "Report hash required");
        require(proposalRef != bytes32(0), "Proposal reference required");
        require(version == latestVersion(assetId) + 1, "Version must be the next in sequence");
        require(effectiveDate > 0 && effectiveDate <= block.timestamp, "Effective date cannot be in the future");

        uint256 n = _history[assetId].length;
        if (n > 0) {
            require(effectiveDate >= _history[assetId][n - 1].effectiveDate, "Effective date earlier than previous version");
        }

        // Reverts with "Asset does not exist" for unknown ids.
        IAssetRegistry.AssetRecord memory asset = assetRegistry.getAsset(assetId);
        require(asset.status == IAssetRegistry.AssetStatus.Tokenized, "Asset must be tokenized");
        uint256 supply = assetToken.totalShares(assetId);
        require(supply > 0, "Asset has no issued tokens");

        _history[assetId].push(ValuationRecord({
            version: version,
            valuation: newValuation,
            currency: currency,
            effectiveDate: effectiveDate,
            reportHash: reportHash,
            proposalRef: proposalRef,
            previousValuation: asset.valuationLKR,
            tokenSupply: supply,
            publisher: msg.sender,
            publishedAt: uint64(block.timestamp)
        }));

        // Keep the registry (read by the token, marketplace and portfolios) in step.
        assetRegistry.updateAssetValuation(assetId, newValuation);

        emit ValuationPublished(
            assetId, version, asset.valuationLKR, newValuation, supply,
            currency, effectiveDate, reportHash, proposalRef, msg.sender
        );
    }

    function latestVersion(uint256 assetId) public view returns (uint64) {
        uint256 n = _history[assetId].length;
        return n == 0 ? 0 : _history[assetId][n - 1].version;
    }

    function getValuation(uint256 assetId, uint64 version) external view returns (ValuationRecord memory) {
        require(version > 0 && version <= _history[assetId].length, "Version not published");
        return _history[assetId][version - 1];
    }

    function getHistory(uint256 assetId) external view returns (ValuationRecord[] memory) {
        return _history[assetId];
    }

    /// @dev Reference price in hundredths of a currency unit (LKR cents), rounded down.
    function getReferencePriceCents(uint256 assetId) external view returns (uint256) {
        uint256 supply = assetToken.totalShares(assetId);
        require(supply > 0, "Asset has no issued tokens");
        return (assetRegistry.getAsset(assetId).valuationLKR * 100) / supply;
    }
}
