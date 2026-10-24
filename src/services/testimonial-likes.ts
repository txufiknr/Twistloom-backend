import { and, eq, sql } from 'drizzle-orm';
import { dbWrite } from '../db/client.js';
import { bookTestimonials, books, userLikes } from '../db/schema.js';

export type TestimonialLikeResult =
  | { kind: 'not-found' }
  | {
      kind: 'ok';
      changed: boolean;
      liked: boolean;
      likesCount: number;
      authorId: string | null;
      bookTitle: string | null;
      bookSlug: string | null;
      like: typeof userLikes.$inferSelect | null;
    };

/**
 * The sole mutation path for book-testimonial likes. Locking the testimonial
 * first serializes counter changes and gives every endpoint the same visibility
 * check and lock order. Notification delivery remains a post-commit concern.
 */
export async function setTestimonialLike(input: {
  userId: string;
  testimonialId: string;
  bookId?: string;
  liked: boolean;
}): Promise<TestimonialLikeResult> {
  return dbWrite.transaction(async (tx) => {
    const conditions = [eq(bookTestimonials.id, input.testimonialId)];
    if (input.bookId) conditions.push(eq(bookTestimonials.bookId, input.bookId));

    const [testimonial] = await tx
      .select({
        id: bookTestimonials.id,
        bookId: bookTestimonials.bookId,
        authorId: bookTestimonials.userId,
        status: bookTestimonials.status,
        likesCount: bookTestimonials.likesCount,
      })
      .from(bookTestimonials)
      .where(and(...conditions))
      .limit(1)
      .for('update');

    // Public testimonial readers expose only approved submissions. Keep both
    // like APIs aligned with that visibility contract.
    if (!testimonial || testimonial.status !== 'approved') return { kind: 'not-found' };

    const [book] = await tx
      .select({ title: books.title, slug: books.slug })
      .from(books)
      .where(eq(books.id, testimonial.bookId))
      .limit(1);

    if (input.liked) {
      const [inserted] = await tx
        .insert(userLikes)
        .values({
          userId: input.userId,
          targetType: 'testimonial',
          targetId: testimonial.id,
        })
        .onConflictDoNothing()
        .returning();

      if (!inserted) {
        const [existingLike] = await tx
          .select()
          .from(userLikes)
          .where(and(
            eq(userLikes.userId, input.userId),
            eq(userLikes.targetType, 'testimonial'),
            eq(userLikes.targetId, testimonial.id),
          ))
          .limit(1);
        return {
          kind: 'ok', changed: false, liked: true,
          likesCount: testimonial.likesCount,
          authorId: testimonial.authorId,
          bookTitle: book?.title ?? null,
          bookSlug: book?.slug ?? null,
          like: existingLike ?? null,
        };
      }

      const [updated] = await tx
        .update(bookTestimonials)
        .set({ likesCount: sql`${bookTestimonials.likesCount} + 1`, updatedAt: new Date() })
        .where(eq(bookTestimonials.id, testimonial.id))
        .returning({ likesCount: bookTestimonials.likesCount });

      return {
        kind: 'ok', changed: true, liked: true,
        likesCount: updated?.likesCount ?? testimonial.likesCount + 1,
        authorId: testimonial.authorId,
        bookTitle: book?.title ?? null,
        bookSlug: book?.slug ?? null,
        like: inserted,
      };
    }

    const deleted = await tx
      .delete(userLikes)
      .where(and(
        eq(userLikes.userId, input.userId),
        eq(userLikes.targetType, 'testimonial'),
        eq(userLikes.targetId, testimonial.id),
      ))
      .returning({ userId: userLikes.userId });

    if (deleted.length === 0) {
      return {
        kind: 'ok', changed: false, liked: false,
        likesCount: testimonial.likesCount,
        authorId: testimonial.authorId,
        bookTitle: book?.title ?? null,
        bookSlug: book?.slug ?? null,
        like: null,
      };
    }

    const [updated] = await tx
      .update(bookTestimonials)
      .set({
        likesCount: sql`GREATEST(0, ${bookTestimonials.likesCount} - 1)`,
        updatedAt: new Date(),
      })
      .where(eq(bookTestimonials.id, testimonial.id))
      .returning({ likesCount: bookTestimonials.likesCount });

    return {
      kind: 'ok', changed: true, liked: false,
      likesCount: updated?.likesCount ?? Math.max(0, testimonial.likesCount - 1),
      authorId: testimonial.authorId,
      bookTitle: book?.title ?? null,
      bookSlug: book?.slug ?? null,
      like: null,
    };
  });
}
