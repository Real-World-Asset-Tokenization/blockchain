// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

/**
 * @title BaselineMultiMint
 * @dev Benchmark-only baseline for the single-transaction minting optimization: it creates the same
 * fractional supply as AssetToken.tokenizeAsset, but one token per transaction. It is not used by the platform.
 */
contract BaselineMultiMint is ERC1155 {
    constructor() ERC1155("") {}

    function mintOne(address to, uint256 assetId) external {
        _mint(to, assetId, 1, "");
    }

    /// The optimized approach: the whole supply in one transaction.
    function mintAll(address to, uint256 assetId, uint256 amount) external {
        _mint(to, assetId, amount, "");
    }
}
