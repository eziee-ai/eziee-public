// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {EzieeTestToken} from "../src/EzieeTestToken.sol";

/// @notice Deploys EzieeTestToken. Env: OWNER (default msg.sender), FAUCET_AMOUNT, FAUCET_COOLDOWN (optional).
contract Deploy is Script {
    string private constant NAME = "eziee Test Token";
    string private constant SYMBOL = "EZT";
    uint256 private constant DEFAULT_FAUCET_AMOUNT = 1_000 ether;
    uint256 private constant DEFAULT_FAUCET_COOLDOWN = 1 days;

    function run() external returns (EzieeTestToken token) {
        address owner = vm.envOr("OWNER", msg.sender);
        uint256 amount = vm.envOr("FAUCET_AMOUNT", DEFAULT_FAUCET_AMOUNT);
        uint256 cooldown = vm.envOr("FAUCET_COOLDOWN", DEFAULT_FAUCET_COOLDOWN);

        vm.startBroadcast();
        token = new EzieeTestToken(NAME, SYMBOL, owner, amount, cooldown);
        vm.stopBroadcast();

        console2.log("EzieeTestToken:", address(token));
        console2.log("owner:", owner);
        console2.log("faucetAmount:", amount);
        console2.log("faucetCooldown:", cooldown);
    }
}
