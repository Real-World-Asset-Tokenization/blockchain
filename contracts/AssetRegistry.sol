// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IAssetRegistry.sol";

/**
 * @title AssetRegistry
 * @dev Manages asset onboarding, verification, and legal document hashing
 * before fractional tokenization is authorized.
 */
contract AssetRegistry is Ownable, IAssetRegistry {
    uint256 public nextAssetId = 1;
    address public assetTokenContract;

    mapping(uint256 => AssetRecord) private _assets;
    mapping(address => uint256[]) private _issuerAssets;
    uint256[] private _allAssetIds;

    mapping(address => bool) public authorizedVerifiers;

    modifier onlyTokenContract() {
        require(msg.sender == assetTokenContract, "Caller is not AssetToken contract");
        _;
    }

    modifier onlyVerifierOrOwner() {
        if (!authorizedVerifiers[msg.sender]) {
            _checkOwner();
        }
        _;
    }

    constructor() Ownable(msg.sender) {}

    /**
     * @dev Connects the deployed AssetToken contract.
     */
    function setAssetTokenContract(address _tokenContract) external onlyOwner {
        require(_tokenContract != address(0), "Invalid token contract address");
        assetTokenContract = _tokenContract;
    }

    /**
     * @dev Sets or revokes an authorized verification role.
     */
    function setAuthorizedVerifier(address verifier, bool isAuthorized) external onlyOwner {
        require(verifier != address(0), "Invalid verifier address");
        authorizedVerifiers[verifier] = isAuthorized;
    }

    /**
     * @dev Register a new real-world asset for verification.
     */
    function registerAsset(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        string calldata documentHash,
        uint256 valuationLKR,
        uint256 totalShares
    ) external override returns (uint256) {
        require(bytes(name).length > 0, "Asset name required");
        require(bytes(metadataURI).length > 0, "Metadata URI required");
        require(bytes(documentHash).length > 0, "Document hash required");
        require(valuationLKR > 0, "Valuation must be > 0");
        require(totalShares > 0, "Total shares must be > 0");

        uint256 assetId = nextAssetId++;

        _assets[assetId] = AssetRecord({
            assetId: assetId,
            name: name,
            symbol: symbol,
            metadataURI: metadataURI,
            documentHash: documentHash,
            valuationLKR: valuationLKR,
            totalShares: totalShares,
            issuer: msg.sender,
            status: AssetStatus.Pending,
            createdAt: block.timestamp,
            tokenizedAt: 0
        });

        _issuerAssets[msg.sender].push(assetId);
        _allAssetIds.push(assetId);

        emit AssetRegistered(
            assetId,
            msg.sender,
            name,
            valuationLKR,
            totalShares,
            metadataURI,
            documentHash
        );

        return assetId;
    }

    /**
     * @dev Authorized verifier or admin approves asset after off-chain deed & valuation verification.
     */
    function approveAsset(uint256 assetId) external override onlyVerifierOrOwner {
        AssetRecord storage asset = _assets[assetId];
        require(asset.assetId != 0, "Asset does not exist");
        require(asset.status == AssetStatus.Pending, "Asset is not pending");

        asset.status = AssetStatus.Approved;
        emit AssetApproved(assetId, msg.sender);
    }

    /**
     * @dev Authorized verifier or admin rejects asset if verification fails.
     */
    function rejectAsset(uint256 assetId, string calldata reason) external override onlyVerifierOrOwner {
        AssetRecord storage asset = _assets[assetId];
        require(asset.assetId != 0, "Asset does not exist");
        require(asset.status == AssetStatus.Pending, "Asset is not pending");

        asset.status = AssetStatus.Rejected;
        emit AssetRejected(assetId, msg.sender, reason);
    }

    /**
     * @dev Updates approved net asset valuation without altering token supply.
     * Triggers updated reference price per token.
     */
    function updateAssetValuation(uint256 assetId, uint256 newValuationLKR) external override onlyVerifierOrOwner {
        require(newValuationLKR > 0, "Valuation must be > 0");
        AssetRecord storage asset = _assets[assetId];
        require(asset.assetId != 0, "Asset does not exist");
        require(
            asset.status == AssetStatus.Approved || asset.status == AssetStatus.Tokenized,
            "Asset must be approved or tokenized"
        );

        uint256 oldValuation = asset.valuationLKR;
        asset.valuationLKR = newValuationLKR;
        emit AssetValuationUpdated(assetId, newValuationLKR, oldValuation, block.timestamp);
    }

    /**
     * @dev Calculates initial token reference price: Approved Valuation / Total Shares.
     */
    function getInitialReferencePrice(uint256 assetId) external view override returns (uint256) {
        AssetRecord memory asset = _assets[assetId];
        require(asset.assetId != 0, "Asset does not exist");
        require(asset.totalShares > 0, "Total shares must be > 0");
        return asset.valuationLKR / asset.totalShares;
    }

    /**
     * @dev Called by AssetToken contract when minting fractional tokens.
     */
    function markTokenized(uint256 assetId) external override onlyTokenContract {
        AssetRecord storage asset = _assets[assetId];
        require(asset.assetId != 0, "Asset does not exist");
        require(asset.status == AssetStatus.Approved, "Asset must be approved before tokenizing");

        asset.status = AssetStatus.Tokenized;
        asset.tokenizedAt = block.timestamp;

        emit AssetMarkedTokenized(assetId, msg.sender);
    }

    function getAsset(uint256 assetId) external view override returns (AssetRecord memory) {
        require(_assets[assetId].assetId != 0, "Asset does not exist");
        return _assets[assetId];
    }

    function isAssetApproved(uint256 assetId) external view override returns (bool) {
        return _assets[assetId].status == AssetStatus.Approved;
    }

    function isAssetTokenized(uint256 assetId) external view override returns (bool) {
        return _assets[assetId].status == AssetStatus.Tokenized;
    }

    function getAllAssetIds() external view returns (uint256[] memory) {
        return _allAssetIds;
    }

    function getAssetsByIssuer(address issuer) external view returns (uint256[] memory) {
        return _issuerAssets[issuer];
    }
}
