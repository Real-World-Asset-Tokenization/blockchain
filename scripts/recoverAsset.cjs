// Recover an existing database asset on the local development chain only.
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

async function readApi(route) {
  const response = await fetch(`http://127.0.0.1:5001/api/${route}`);
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(body.error || body.message || "API unavailable");
  return body.data;
}

async function main() {
  const id = Number(process.argv[2]);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Supply the existing database asset ID.");
  const asset = await readApi(`assets/${id}`);
  if (String(asset.verificationStatus).toLowerCase() !== "approved") {
    throw new Error("Document verification must be approved before recovery.");
  }
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
  try {
    if ((await provider.getNetwork()).chainId !== 31337n) throw new Error("Local Hardhat chain required.");
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../deployments/deployedContracts.json")));
    const signer = await provider.getSigner(asset.issuerWallet);
    const registry = new ethers.Contract(config.contracts.AssetRegistry.address, config.contracts.AssetRegistry.abi, signer);
    const signerAddress = (await signer.getAddress()).toLowerCase();
    const canApprove = (await registry.owner()).toLowerCase() === signerAddress ||
      await registry.authorizedVerifiers(signerAddress);
    if (!canApprove) throw new Error("An authorized registry verifier must approve this asset.");

    // Preview reconciles an existing matching registration, making retries safe.
    let preview = await readApi(`tokenization/preview/${id}`);
    if (preview.blockchainAssetId == null) {
      if (!preview.documentHash || !preview.metadataURI || !preview.assetName) throw new Error("Registration metadata is incomplete.");
      const tx = await registry.registerAsset(
        preview.assetName, preview.assetSymbol || "", preview.metadataURI,
        preview.documentHash, BigInt(preview.approvedValuation), BigInt(preview.approvedTokenSupply)
      );
      await tx.wait();
      console.log("Registration transaction:", tx.hash);
      preview = await readApi(`tokenization/preview/${id}`);
    }
    if (preview.blockchainAssetId == null) throw new Error("Registration mined but database reconciliation failed. Retry recovery.");
    const record = await registry.getAsset(preview.blockchainAssetId);
    if (record.issuer.toLowerCase() !== signerAddress || record.documentHash !== preview.documentHash) {
      throw new Error("Registry identity mismatch.");
    }
    if (Number(record.status) === 0) {
      const tx = await registry.approveAsset(preview.blockchainAssetId);
      await tx.wait();
      console.log("Approval transaction:", tx.hash);
    } else if (![1, 2].includes(Number(record.status))) {
      throw new Error("Rejected assets cannot be recovered through approval.");
    }
    preview = await readApi(`tokenization/preview/${id}`);
    console.log(JSON.stringify({ assetId: id, blockchainAssetId: preview.blockchainAssetId, isEligible: preview.isEligible, status: preview.existingStatus }));
  } finally {
    provider.destroy();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
