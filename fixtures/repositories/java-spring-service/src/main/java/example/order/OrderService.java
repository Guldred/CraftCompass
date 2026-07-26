package example.order;

public final class OrderService {
    public boolean mayCancel(boolean fulfilled) {
        return !fulfilled;
    }
}
