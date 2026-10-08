# Teammate Integration Guide — Asset Tokenization & Registry Core

This document provides complete instructions for teammates building the **Marketplace (Trading)**, **Governance (Voting)**, and **Profit Distribution** modules to integrate with the core **Asset Tokenization & Registry** contracts.

---

## 1. Contracts & Architecture Overview

The core system consists of two main contracts:

1. **`AssetRegistry.sol`** (`IAssetRegistry.sol`):
   - Handles asset onboarding, off-chain metadata (IPFS URI), legal deed verification hashes, valuation (LKR), and verification status (`Pending`, `Approved`, `Tokenized`, `Rejected`).
2. **`AssetToken.sol`** (`IAssetToken.sol`):
   - ERC-1155 fractional token representing fractional shares of the real-world property.
   - 1 token unit = fractional share of the corresponding `assetId`.
   - Includes built-in **Snapshot Checkpoints** for governance voting and dividend distributions.

Both interfaces are located in:
`blockchain/contracts/interfaces/IAssetRegistry.sol`  
`blockchain/contracts/interfaces/IAssetToken.sol`

---

## 2. Shared Contract Interfaces for Your Contracts

To interact with Asset Tokens, your contracts simply import `IAssetToken.sol`:

```solidity
import "./interfaces/IAssetToken.sol";

contract YourModule {
    IAssetToken public immutable assetToken;

    constructor(address _assetTokenAddress) {
        assetToken = IAssetToken(_assetTokenAddress);
    }
}
```

---

## 3. Integration by Module

### A. For Marketplace / Trading Teammate
The Marketplace needs to list fractional tokens, execute purchases, and escrow or transfer tokens upon payment.

1. **Check Investor Balance Before Listing:**
   ```solidity
   uint256 balance = assetToken.balanceOf(seller, assetId);
   require(balance >= amountToList, "Insufficient fractional shares");
   ```

2. **Verify Asset is Tokenized:**
   ```solidity
   require(assetToken.isTokenized(assetId), "Asset not tokenized");
   ```

3. **Transfer Tokens to Buyer Upon Payment:**
   The seller first calls `assetToken.setApprovalForAll(marketplaceAddress, true)` from their wallet.
   The marketplace contract then calls:
   ```solidity
   assetToken.safeTransferFrom(seller, buyer, assetId, amountBought, "");
   ```

---

### B. For Governance / Voting Teammate
Governance needs to prevent the **"Double-Voting / Flash-Loan Exploit"** (where an investor votes, transfers tokens to another wallet, and votes again).

The core `AssetToken` contract includes built-in **Snapshots**:

1. **When a Proposal is Created:**
   The Governance contract triggers a snapshot for the asset:
   ```solidity
   uint256 snapshotId = assetToken.createSnapshot(assetId);
   // Store snapshotId in Proposal struct
   ```

2. **When an Investor Casts a Vote:**
   Instead of using current balance, query the snapshot balance:
   ```solidity
   uint256 votingPower = assetToken.balanceOfAtSnapshot(voter, assetId, proposal.snapshotId);
   require(votingPower > 0, "No voting power at proposal snapshot");
   ```

3. **Get Total Eligible Voting Supply:**
   ```solidity
   uint256 totalShares = assetToken.totalShares(assetId);
   // Quorum can be calculated as: totalShares * quorumPercentage / 100
   ```

---

### C. For Profit Distribution Teammate
Profit distribution distributes simulated rental income or dividend profits proportional to fractional ownership:

$$\text{Investor Payout} = \frac{\text{Investor Tokens}}{\text{Eligible Total Tokens}} \times \text{Distributable Profit}$$

1. **When Admin Funds a Profit Distribution Period:**
   Trigger a snapshot for that distribution epoch:
   ```solidity
   uint256 snapshotId = assetToken.createSnapshot(assetId);
   // Record totalDistributableAmount and snapshotId
   ```

2. **When Investor Claims Dividend:**
   Query their verified entitlement at the time the profit was declared:
   ```solidity
   uint256 investorShares = assetToken.balanceOfAtSnapshot(investor, assetId, period.snapshotId);
   uint256 totalShares = assetToken.totalShares(assetId);

   uint256 payout = (period.distributableAmount * investorShares) / totalShares;
   // Transfer test ETH or test ERC-20 to investor
   ```

---

## 4. Local Deployment Addresses

When running on local Hardhat node (`http://127.0.0.1:8545`, Chain ID `31337`):

| Contract | Address |
| --- | --- |
| `AssetRegistry` | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| `AssetToken` | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` |

ABIs and deployment JSON are exported in:
- `blockchain/deployments/localhost.json`
- `asset-tokenization-frontend/src/contracts/deployedContracts.json`
