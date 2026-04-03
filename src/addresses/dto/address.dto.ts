export class CreateAddressDto {
  label?: string;
  recipientName: string;
  street: string;
  number: string;
  complement?: string;
  neighborhood?: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
  isDefault?: boolean;
}

export class UpdateAddressDto {
  label?: string;
  recipientName?: string;
  street?: string;
  number?: string;
  complement?: string;
  neighborhood?: string;
  city?: string;
  state?: string;
  zip?: string;
  isDefault?: boolean;
}
