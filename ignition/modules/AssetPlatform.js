const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

module.exports = buildModule("AssetPlatform", (m) => {
  // 1. AssetRegistry
  const assetRegistry = m.contract("AssetRegistry");

  // 2. AssetToken
  const assetToken = m.contract("AssetToken", [assetRegistry]);

  // Link token to registry
  m.call(assetRegistry, "setAssetTokenContract", [assetToken]);

  // 3. AssetMarketplace
  const assetMarketplace = m.contract("AssetMarketplace", [assetToken]);

  // 4. AssetGovernance
  const assetGovernance = m.contract("AssetGovernance", [assetToken]);

  // 5. ProfitDistribution
  const profitDistribution = m.contract("ProfitDistribution", [assetToken]);

  // Configure snapshot authorization
  m.call(assetToken, "setAuthorizedCaller", [assetGovernance, true], { id: "authGov" });
  m.call(assetToken, "setAuthorizedCaller", [profitDistribution, true], { id: "authDist" });

  return {
    assetRegistry,
    assetToken,
    assetMarketplace,
    assetGovernance,
    profitDistribution,
  };
});
