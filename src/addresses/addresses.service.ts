import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../database/database.module';
import * as schema from '../database/schema';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';

@Injectable()
export class AddressesService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: LibSQLDatabase<typeof schema>,
  ) {}

  async findAll(userId: string) {
    return this.db
      .select()
      .from(schema.addresses)
      .where(eq(schema.addresses.userId, userId));
  }

  async create(userId: string, dto: CreateAddressDto) {
    // Se o novo endereço for padrão, remove o padrão anterior
    if (dto.isDefault) {
      await this.db
        .update(schema.addresses)
        .set({ isDefault: false })
        .where(eq(schema.addresses.userId, userId));
    }

    const [created] = await this.db
      .insert(schema.addresses)
      .values({
        userId,
        label: dto.label,
        recipientName: dto.recipientName,
        street: dto.street,
        number: dto.number,
        complement: dto.complement,
        neighborhood: dto.neighborhood,
        city: dto.city,
        state: dto.state,
        zip: dto.zip,
        country: dto.country ?? 'BR',
        isDefault: dto.isDefault ?? false,
      })
      .returning();

    return created;
  }

  async update(userId: string, addressId: string, dto: UpdateAddressDto) {
    const [address] = await this.db
      .select()
      .from(schema.addresses)
      .where(
        and(
          eq(schema.addresses.id, addressId),
          eq(schema.addresses.userId, userId),
        ),
      );

    if (!address) throw new NotFoundException('Endereço não encontrado');

    // Se o endereço atualizado for padrão, remove o padrão anterior
    if (dto.isDefault) {
      await this.db
        .update(schema.addresses)
        .set({ isDefault: false })
        .where(eq(schema.addresses.userId, userId));
    }

    await this.db
      .update(schema.addresses)
      .set({ ...dto, updatedAt: new Date() })
      .where(eq(schema.addresses.id, addressId));

    const [updated] = await this.db
      .select()
      .from(schema.addresses)
      .where(eq(schema.addresses.id, addressId));

    return updated;
  }

  async remove(userId: string, addressId: string) {
    const [address] = await this.db
      .select()
      .from(schema.addresses)
      .where(
        and(
          eq(schema.addresses.id, addressId),
          eq(schema.addresses.userId, userId),
        ),
      );

    if (!address) throw new NotFoundException('Endereço não encontrado');
    if (address.userId !== userId) throw new ForbiddenException('Acesso negado');

    await this.db
      .delete(schema.addresses)
      .where(eq(schema.addresses.id, addressId));
  }
}
