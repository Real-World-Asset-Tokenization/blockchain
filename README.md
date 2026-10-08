# RWA Tokenization — Blockchain & Smart Contracts

> **University Research Prototype:** Hardhat + Solidity `0.8.24` (Cancun EVM Target) + OpenZeppelin Contracts v5  
> **Target Network:** Hardhat Local (Chain ID `31337`, Port `8545`) / Sepolia Testnet

---

## 1. Overview

This package contains the core on-chain infrastructure for fractional real-world asset (RWA) tokenization, escrow-based marketplace trading, token-weighted governance voting, and rental dividend waterfalls.

### Smart Contracts
1. **[`AssetRegistry.sol`](file:///d:/Research/Development/Implementation/blockchain/contracts/AssetRegistry.sol):** Legal property title deed onboarding, SHA-256 cryptographic digest binding, and administrative verification.
2. **[`AssetToken.sol`](file:///d:/Research/Development/Implementation/blockchain/contracts/AssetToken.sol):** ERC-1155 fractional ownership token with dynamic checkpoint snapshot capabilities (`createSnapshot`, `balanceOfAtSnapshot`).
3. **[`AssetMarketplace.sol`](file:///d:/Research/Development/Implementation/blockchain/contracts/AssetMarketplace.sol):** Secondary trading with non-reentrant escrow and atomic settlement of ETH and tokens.
4. **[`AssetGovernance.sol`](file:///d:/Research/Development/Implementation/blockchain/contracts/AssetGovernance.sol):** Snapshot-weighted DAO voting preventing double-voting and post-snapshot share manipulation.
5. **[`ProfitDistribution.sol`](file:///d:/Research/Development/Implementation/blockchain/contracts/ProfitDistribution.sol):** Proportional rental income waterfall distribution with pull-based dividend claims.

---

## 2. Prerequisites & Setup

Ensure Node.js (v20 or v22) is installed.

```bash
cd blockchain
npm install
```

---

## 3. How to Run & Deploy

### Step 1: Start the Local Blockchain Node
```bash
npx hardhat node
```
This runs a local EVM node at `http://127.0.0.1:8545` with Chain ID `31337` and 20 pre-funded test accounts (10,000 ETH each).

### Step 2: Compile Contracts
```bash
npx hardhat compile
```
Compiles all 5 Solidity contracts into `artifacts/`.

### Step 3: Deploy & Seed Platform
In a separate terminal:
```bash
npx hardhat run scripts/deploy.js --network localhost
```
**What this script does:**
- Deploys `AssetRegistry`, `AssetToken`, `AssetMarketplace`, `AssetGovernance`, and `ProfitDistribution`.
- Links contracts and authorizes snapshot triggers.
- Seeds sample real-world properties:
  - **Asset #1:** Colombo Oceanfront Residence (1,000 shares, LKR 10M) - *Tokenized*
  - **Asset #2:** Kandy Royal Commercial Plaza (5,000 shares, LKR 50M) - *Pending*
  - **Asset #3:** Galle Dutch Fort Heritage Villa (2,500 shares, LKR 25M) - *Pending*
- Distributes shares across 3 test personas (500 to User 1, 300 to User 2, 200 to User 3).
- Creates an initial marketplace listing and an active governance proposal.
- Funds a `0.5 ETH` rental yield pool for payout testing.
- Automatically exports contract ABIs and addresses to:
  - `shared/abi/`
  - `shared/deployments/localhost.json`
  - `asset-tokenization-frontend/src/contracts/deployedContracts.json`
  - `asset-tokenization-backend/src/contracts/deployedContracts.json`

### Alternative: Deploy with Hardhat Ignition
```bash
npx hardhat ignition deploy ignition/modules/AssetPlatform.js --network localhost
```

---

## 4. Running Evaluation Tests (TC01 – TC16)

Run the full evaluation test suite matching the university research test plan:

```bash
npx hardhat test test/ResearchEvaluation_TC01_TC16.test.js
```

### Verified Test Cases:
| Test ID | Category | Description | Status |
| :--- | :--- | :--- | :---: |
| **TC01** | Tokenization | Admin mints 1,000 shares for approved asset | **PASSED** |
| **TC02** | Access Control | Unauthorized asset creation or approval reverts | **PASSED** |
| **TC03** | Boundary Check | Zero supply registration reverts | **PASSED** |
| **TC04** | Transfers | P2P transfer updates sender and recipient balances | **PASSED** |
| **TC05** | Balances | Transferring more tokens than owned reverts | **PASSED** |
| **TC06** | Marketplace | Atomic settlement of shares and ETH payment | **PASSED** |
| **TC07** | Marketplace | Unauthorized listing cancellation reverts | **PASSED** |
| **TC08** | Governance | Vote during proposal period recorded with snapshot weight | **PASSED** |
| **TC09** | Governance | Duplicate voting on the same proposal reverts | **PASSED** |
| **TC10** | Governance | Voting after proposal deadline block reverts | **PASSED** |
| **TC11** | Profit Waterfall | Funding rental yield pool records period and snapshot | **PASSED** |
| **TC12** | Profit Waterfall | Eligible 50% shareholder claims exact 0.5 ETH payout | **PASSED** |
| **TC13** | Profit Waterfall | Claiming payout twice reverts | **PASSED** |
| **TC14** | Snapshot Check | Transferring shares post-snapshot preserves prior claim | **PASSED** |
| **TC15** | Security Control | Non-shareholder claiming yields reverts | **PASSED** |
| **TC16** | Metadata Integrity| Unauthorized tampering with token state reverts | **PASSED** |

---

## 5. Deployed Contract Addresses (Localhost 31337)

| Contract | Address |
| :--- | :--- |
| **AssetRegistry** | `0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0` |
| **AssetToken** | `0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82` |
| **AssetMarketplace** | `0x0B306BF915C4d645ff596e518fAf3F9669b97016` |
| **AssetGovernance** | `0x959922bE3CAee4b8Cd9a407cc3ac1C251C2007B1` |
| **ProfitDistribution** | `0x9A9f2CCfdE556A7E9Ff0848998Aa4a0CFD8863AE` |

---

## 6. Development Accounts & Private Keys

| Persona | Address | Private Key |
| :--- | :--- | :--- |
| **User 1 (Admin/Deployer)** | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` |
| **User 2 (Investor B)** | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` |
| **User 3 (Partner C)** | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` | `0x5de4111afa1a4b94908f83103eb2f95402bbf309988307374433a625ffb6ee92` |