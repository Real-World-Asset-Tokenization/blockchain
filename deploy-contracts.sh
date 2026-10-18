#!/bin/bash

echo "=================================================="
echo "Deploying Blockchain Contracts"
echo "=================================================="

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Deploy contracts
echo "Deploying contracts to local Hardhat network..."
npx hardhat run scripts/deploy.js --network localhost

echo "=================================================="
echo "Deployment Complete!"
echo "=================================================="
echo "Contracts deployed and ABIs synced to:"
echo "  - blockchain/deployments/"
echo "  - shared/deployments/"
echo "  - asset-tokenization-frontend/src/contracts/"
echo "  - asset-tokenization-backend/src/contracts/"
echo "=================================================="
