// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockPaymentToken
 * @dev ERC-20 mock payment token (e.g. Mock USD / mUSD) simulating a stable payment asset
 * for secondary marketplace purchases and dividend funding.
 */
contract MockPaymentToken is ERC20, ERC20Permit, Ownable {
    uint8 private _customDecimals;

    constructor(
        string memory name,
        string memory symbol,
        uint8 customDecimals_
    ) ERC20(name, symbol) ERC20Permit(name) Ownable(msg.sender) {
        _customDecimals = customDecimals_;
        // Mint initial supply of 10,000,000 tokens to deployer
        _mint(msg.sender, 10_000_000 * (10 ** customDecimals_));
    }

    function decimals() public view virtual override returns (uint8) {
        return _customDecimals;
    }

    /**
     * @dev Mint function for testing and demonstration faucet.
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
