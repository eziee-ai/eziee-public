// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title EzieeTestToken
/// @author eziee
/// @notice TEST payment token for eziee on Arc testnet. It has no value.
/// @dev Users send it to a treasury to buy app credit at an offchain, admin-set rate.
///      Testers mint it from an open faucet with a per-address cooldown.
///      INVARIANT: totalSupply == sum of faucet claims + owner mints.
/// @custom:security-contact security@eziee.ai
contract EzieeTestToken is ERC20, Ownable2Step {
    /// @notice Longest allowed cooldown; keeps `lastClaim + faucetCooldown` far from overflow
    uint256 public constant MAX_FAUCET_COOLDOWN = 365 days;

    /// @notice Amount minted to a caller of `claim`; zero disables the faucet
    uint256 public faucetAmount;

    /// @notice Minimum seconds between two claims by the same address
    uint256 public faucetCooldown;

    /// @notice Timestamp of the last successful claim per address
    mapping(address account => uint256 timestamp) public lastClaim;

    /// @notice Emitted when a tester claims from the faucet
    event Claimed(address indexed to, uint256 amount);

    /// @notice Emitted when the owner changes the faucet parameters
    event FaucetUpdated(uint256 oldAmount, uint256 newAmount, uint256 oldCooldown, uint256 newCooldown);

    /// @notice The caller must wait until `nextClaimAt` to claim again
    error ClaimTooSoon(uint256 nextClaimAt);

    /// @notice The faucet is disabled (amount is zero)
    error FaucetOff();

    /// @notice The cooldown is above `MAX_FAUCET_COOLDOWN`
    error CooldownTooLong(uint256 cooldown);

    /// @param name_ Token name
    /// @param symbol_ Token symbol
    /// @param owner_ Initial owner (can mint and configure the faucet)
    /// @param faucetAmount_ Tokens minted per claim (zero disables the faucet)
    /// @param faucetCooldown_ Seconds between claims per address
    constructor(
        string memory name_,
        string memory symbol_,
        address owner_,
        uint256 faucetAmount_,
        uint256 faucetCooldown_
    ) ERC20(name_, symbol_) Ownable(owner_) {
        if (faucetCooldown_ > MAX_FAUCET_COOLDOWN) revert CooldownTooLong(faucetCooldown_);
        faucetAmount = faucetAmount_;
        faucetCooldown = faucetCooldown_;
        emit FaucetUpdated(0, faucetAmount_, 0, faucetCooldown_);
    }

    /// @notice Claims `faucetAmount` tokens for the caller, once per cooldown
    /// @dev Reverts with `FaucetOff` if disabled and `ClaimTooSoon` inside the cooldown.
    ///      A first-time claimer (lastClaim == 0) is never rate limited.
    function claim() external {
        uint256 amount = faucetAmount;
        if (amount == 0) revert FaucetOff();

        uint256 last = lastClaim[msg.sender];
        if (last != 0) {
            uint256 next = last + faucetCooldown;
            if (block.timestamp < next) revert ClaimTooSoon(next);
        }

        lastClaim[msg.sender] = block.timestamp;
        emit Claimed(msg.sender, amount);
        _mint(msg.sender, amount);
    }

    /// @notice Mints tokens to any address
    /// @param to Recipient
    /// @param amount Amount in wei units (18 decimals)
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Updates the faucet amount and cooldown
    /// @param amount New tokens per claim (zero disables the faucet)
    /// @param cooldown New seconds between claims per address
    function setFaucet(uint256 amount, uint256 cooldown) external onlyOwner {
        if (cooldown > MAX_FAUCET_COOLDOWN) revert CooldownTooLong(cooldown);
        emit FaucetUpdated(faucetAmount, amount, faucetCooldown, cooldown);
        faucetAmount = amount;
        faucetCooldown = cooldown;
    }

    /// @notice Earliest timestamp at which `account` can claim again
    /// @param account The address to check
    /// @return The timestamp; a value at or below `block.timestamp` means it can claim now
    function nextClaimAt(address account) external view returns (uint256) {
        uint256 last = lastClaim[account];
        return last == 0 ? 0 : last + faucetCooldown;
    }
}
