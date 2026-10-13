// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EzieeTestToken} from "../src/EzieeTestToken.sol";

contract EzieeTestTokenTest is Test {
    uint256 private constant FAUCET_AMOUNT = 1_000 ether;
    uint256 private constant COOLDOWN = 1 days;

    EzieeTestToken internal token;
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    event Claimed(address indexed to, uint256 amount);
    event FaucetUpdated(uint256 oldAmount, uint256 newAmount, uint256 oldCooldown, uint256 newCooldown);

    function setUp() public {
        vm.warp(1_700_000_000);
        token = new EzieeTestToken("eziee Test Token", "EZT", owner, FAUCET_AMOUNT, COOLDOWN);
    }

    function test_metadata() public view {
        assertEq(token.name(), "eziee Test Token");
        assertEq(token.symbol(), "EZT");
        assertEq(token.decimals(), 18);
        assertEq(token.owner(), owner);
        assertEq(token.faucetAmount(), FAUCET_AMOUNT);
        assertEq(token.faucetCooldown(), COOLDOWN);
        assertEq(token.totalSupply(), 0);
    }

    function test_claim_mintsFaucetAmount() public {
        vm.expectEmit(true, false, false, true);
        emit Claimed(alice, FAUCET_AMOUNT);
        vm.prank(alice);
        token.claim();

        assertEq(token.balanceOf(alice), FAUCET_AMOUNT);
        assertEq(token.totalSupply(), FAUCET_AMOUNT);
        assertEq(token.lastClaim(alice), block.timestamp);
        assertEq(token.nextClaimAt(alice), block.timestamp + COOLDOWN);
    }

    function test_nextClaimAt_isZeroBeforeFirstClaim() public view {
        assertEq(token.nextClaimAt(alice), 0);
    }

    function test_claim_revertsWithinCooldown() public {
        vm.prank(alice);
        token.claim();
        uint256 next = token.nextClaimAt(alice);

        vm.warp(block.timestamp + COOLDOWN - 1);
        vm.expectRevert(abi.encodeWithSelector(EzieeTestToken.ClaimTooSoon.selector, next));
        vm.prank(alice);
        token.claim();
    }

    function test_claim_worksAfterCooldown() public {
        vm.prank(alice);
        token.claim();
        vm.warp(block.timestamp + COOLDOWN);
        vm.prank(alice);
        token.claim();
        assertEq(token.balanceOf(alice), 2 * FAUCET_AMOUNT);
    }

    function test_claim_cooldownIsPerAddress() public {
        vm.prank(alice);
        token.claim();
        vm.prank(bob);
        token.claim();
        assertEq(token.balanceOf(bob), FAUCET_AMOUNT);
    }

    function test_claim_zeroCooldownAllowsRepeat() public {
        vm.prank(owner);
        token.setFaucet(FAUCET_AMOUNT, 0);
        vm.startPrank(alice);
        token.claim();
        token.claim();
        vm.stopPrank();
        assertEq(token.balanceOf(alice), 2 * FAUCET_AMOUNT);
    }

    function test_claim_revertsWhenFaucetOff() public {
        vm.prank(owner);
        token.setFaucet(0, COOLDOWN);
        vm.expectRevert(EzieeTestToken.FaucetOff.selector);
        vm.prank(alice);
        token.claim();
    }

    function test_constructor_zeroFaucetStartsOff() public {
        EzieeTestToken t = new EzieeTestToken("x", "X", owner, 0, 0);
        vm.expectRevert(EzieeTestToken.FaucetOff.selector);
        t.claim();
    }

    function test_mint_onlyOwner() public {
        vm.prank(owner);
        token.mint(bob, 5 ether);
        assertEq(token.balanceOf(bob), 5 ether);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        token.mint(alice, 1);
    }

    function test_setFaucet_onlyOwnerAndEmits() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        token.setFaucet(1, 1);

        vm.expectEmit(false, false, false, true);
        emit FaucetUpdated(FAUCET_AMOUNT, 5 ether, COOLDOWN, 1 hours);
        vm.prank(owner);
        token.setFaucet(5 ether, 1 hours);
        assertEq(token.faucetAmount(), 5 ether);
        assertEq(token.faucetCooldown(), 1 hours);
    }

    function test_ownership_twoStepTransfer() public {
        vm.prank(owner);
        token.transferOwnership(alice);
        assertEq(token.owner(), owner);
        assertEq(token.pendingOwner(), alice);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        vm.prank(bob);
        token.acceptOwnership();

        vm.prank(alice);
        token.acceptOwnership();
        assertEq(token.owner(), alice);
        assertEq(token.pendingOwner(), address(0));
    }

    function test_setFaucet_revertsWhenCooldownTooLong() public {
        uint256 tooLong = token.MAX_FAUCET_COOLDOWN() + 1;
        vm.expectRevert(abi.encodeWithSelector(EzieeTestToken.CooldownTooLong.selector, tooLong));
        vm.prank(owner);
        token.setFaucet(FAUCET_AMOUNT, tooLong);
    }

    function test_constructor_revertsWhenCooldownTooLong() public {
        uint256 tooLong = token.MAX_FAUCET_COOLDOWN() + 1;
        vm.expectRevert(abi.encodeWithSelector(EzieeTestToken.CooldownTooLong.selector, tooLong));
        new EzieeTestToken("eziee Test Token", "EZT", owner, FAUCET_AMOUNT, tooLong);
    }

    function testFuzz_claim_amountAndCooldown(uint128 amount, uint64 cooldown, uint64 wait) public {
        amount = uint128(bound(amount, 1, type(uint128).max));
        cooldown = uint64(bound(cooldown, 0, token.MAX_FAUCET_COOLDOWN()));
        vm.prank(owner);
        token.setFaucet(amount, cooldown);

        vm.prank(alice);
        token.claim();
        assertEq(token.balanceOf(alice), amount);

        uint256 next = token.nextClaimAt(alice);
        assertEq(next, block.timestamp + cooldown);

        vm.warp(block.timestamp + wait);
        if (block.timestamp < next) {
            vm.expectRevert(abi.encodeWithSelector(EzieeTestToken.ClaimTooSoon.selector, next));
            vm.prank(alice);
            token.claim();
            assertEq(token.balanceOf(alice), amount);
        } else {
            vm.prank(alice);
            token.claim();
            assertEq(token.balanceOf(alice), uint256(amount) * 2);
        }
    }
}
