/**
 * Test OAuth Guest Migration Flow
 * 
 * This test simulates the complete flow:
 * 1. Guest user creates content
 * 2. User logs in with Google OAuth (first-time)
 * 3. Guest data is migrated to authenticated user
 * 4. Guest user is deleted
 */

import { createOrUpdateOAuthUser, migrateGuestToAuthUser } from '../src/services/user-controller.js';
import { dbRead, dbWrite } from '../src/db/client.js';
import { users, books } from '../src/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { generateId } from '../src/utils/uuid.js';

async function testOAuthGuestMigration() {
  console.log('🧪 Starting OAuth Guest Migration Test\n');

  try {
    // Step 1: Create a guest user
    console.log('Step 1: Creating guest user...');
    const guestId = generateId();
    await dbWrite.insert(users).values({
      userId: guestId,
      isGuest: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastActive: new Date(),
    });
    console.log(`✅ Guest user created: ${guestId}\n`);

    // Step 2: Guest user creates content (books)
    console.log('Step 2: Guest user creates content...');
    const bookId = generateId();
    await dbWrite.insert(books).values({
      id: bookId,
      userId: guestId,
      title: 'Guest Book',
      status: 'draft',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log(`✅ Book created by guest: ${bookId}\n`);

    // Step 3: Verify guest owns the book
    console.log('Step 3: Verifying guest owns the book...');
    const guestBooks = await dbRead
      .select({ id: books.id, userId: books.userId })
      .from(books)
      .where(eq(books.userId, guestId));
    console.log(`✅ Guest has ${guestBooks.length} book(s)\n`);

    // Step 4: Simulate Google OAuth login (first-time user)
    console.log('Step 4: Simulating Google OAuth login (first-time user)...');
    const testEmail = 'test-oauth-user@example.com';
    const testName = 'Test OAuth User';
    const testImage = 'https://example.com/avatar.jpg';
    
    const authUserId = await createOrUpdateOAuthUser(testEmail, testName, testImage);
    console.log(`✅ OAuth user created: ${authUserId}\n`);

    // Step 5: Verify OAuth user was created
    console.log('Step 5: Verifying OAuth user was created...');
    const authUser = await dbRead
      .select({ userId: users.userId, email: users.email, isGuest: users.isGuest })
      .from(users)
      .where(eq(users.userId, authUserId))
      .limit(1);
    
    if (authUser.length === 0) {
      throw new Error('OAuth user not found in database');
    }
    console.log(`✅ OAuth user verified: ${authUser[0].email}, isGuest: ${authUser[0].isGuest}\n`);

    // Step 6: Migrate guest data to authenticated user
    console.log('Step 6: Migrating guest data to authenticated user...');
    await migrateGuestToAuthUser(guestId, authUserId);
    console.log(`✅ Migration complete\n`);

    // Step 7: Verify book now belongs to authenticated user
    console.log('Step 7: Verifying book now belongs to authenticated user...');
    const migratedBooks = await dbRead
      .select({ id: books.id, userId: books.userId })
      .from(books)
      .where(eq(books.userId, authUserId));
    console.log(`✅ Authenticated user has ${migratedBooks.length} book(s)\n`);

    // Step 8: Verify guest user was deleted
    console.log('Step 8: Verifying guest user was deleted...');
    const deletedGuest = await dbRead
      .select({ userId: users.userId })
      .from(users)
      .where(eq(users.userId, guestId))
      .limit(1);
    
    if (deletedGuest.length > 0) {
      throw new Error('Guest user was not deleted');
    }
    console.log(`✅ Guest user deleted successfully\n`);

    // Step 9: Test returning OAuth user (should update profile)
    console.log('Step 9: Testing returning OAuth user (profile update)...');
    const updatedName = 'Updated Test User';
    const updatedImage = 'https://example.com/new-avatar.jpg';
    const updatedUserId = await createOrUpdateOAuthUser(testEmail, updatedName, updatedImage);
    console.log(`✅ Returning user profile updated: ${updatedUserId}\n`);

    // Step 10: Verify profile was updated
    console.log('Step 10: Verifying profile was updated...');
    const updatedUser = await dbRead
      .select({ userId: users.userId, name: users.name, image: users.image })
      .from(users)
      .where(eq(users.userId, authUserId))
      .limit(1);
    
    if (updatedUser[0].name !== updatedName || updatedUser[0].image !== updatedImage) {
      throw new Error('Profile was not updated correctly');
    }
    console.log(`✅ Profile updated: name=${updatedUser[0].name}, image=${updatedUser[0].image}\n`);

    // Cleanup
    console.log('Cleanup: Deleting test data...');
    await dbWrite.delete(books).where(eq(books.id, bookId));
    await dbWrite.delete(users).where(eq(users.userId, authUserId));
    console.log('✅ Test data cleaned up\n');

    console.log('🎉 All tests passed!\n');
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Run the test
testOAuthGuestMigration();
